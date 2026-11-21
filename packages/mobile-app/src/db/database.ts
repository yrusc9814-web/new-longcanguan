import {
  SYNC_COMMAND_ENTITIES,
  type SyncCommandTarget,
  type SyncCommandType,
  type SyncEntityName,
} from '@dafan/shared/sync';

import { LocalApiError } from '../local-api/protocol';
import {
  DatabaseError,
  TransactionBrokenError,
  VersionConflictError,
  asDatabaseError,
} from './errors';
import { AsyncMutex } from './mutex';
import {
  BUSINESS_TABLES,
  DEVICE_LOCAL_CONFIG_TABLE,
  MIGRATE_V1_TO_V2,
  SCHEMA_DDL,
  SCHEMA_VERSION,
  SYNC_OUTBOX_TABLE,
  SYNC_STATE_TABLE,
} from './schema';
import type { RunResult, SqlDriver, SqlValue } from './types';
import { isReadStatement } from './types';

export type { SyncEntityName } from '@dafan/shared/sync';

const SYNC_ENTITIES = new Set<string>(BUSINESS_TABLES);

interface OutboxInputBase {
  /** 幂等键；同一操作的多次重试必须复用同一 opId。 */
  readonly opId: string;
  readonly entity: SyncEntityName;
  readonly entityId: string;
  readonly baseVersion: number | null;
  readonly payload?: Record<string, unknown> | null;
}

export type OutboxOperationInput =
  | (OutboxInputBase & { readonly kind: 'upsert' })
  | (OutboxInputBase & {
      readonly kind: 'delete';
      readonly baseVersion: number;
      /** 删除唯一证据：与本地软删写入的 `deletedAt` 必须是同一字符串。 */
      readonly payload: { readonly deletedAt: string };
    })
  | (OutboxInputBase &
      SyncCommandTarget & {
        readonly kind: 'command';
        readonly payload: Record<string, unknown>;
      });

interface OutboxRow {
  opId: string;
  entity: string;
  entityId: string;
  kind: OutboxOperationInput['kind'];
  commandType: SyncCommandType | null;
  baseVersion: number | null;
  payloadJson: string | null;
  epoch: number;
}

async function hashPayload(payloadJson: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payloadJson));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 对象键排序后的 JSON：键顺序不影响同一操作的重试判定，数组顺序保持敏感。 */
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalJson((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function samePayload(left: string | null, right: string | null): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  try {
    return (
      JSON.stringify(canonicalJson(JSON.parse(left))) ===
      JSON.stringify(canonicalJson(JSON.parse(right)))
    );
  } catch {
    return false;
  }
}

/** 旧 v2 行的 delete 载荷可能带 id/version 等冗余列；重试判定只看 deletedAt。 */
function deletedAtOf(payloadJson: string | null): string | null {
  if (payloadJson === null) return null;
  try {
    const value = (JSON.parse(payloadJson) as { deletedAt?: unknown }).deletedAt;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

export interface VersionedUpdateSpec {
  readonly table: SyncEntityName;
  readonly id: string | number;
  readonly expectedVersion: number;
  /** 除 version 外的列赋值；值为 undefined 的列会被忽略。 */
  readonly values: Readonly<Record<string, SqlValue | undefined>>;
  /** 是否要求 `deletedAt IS NULL`（默认 true，与上游软删语义一致）。 */
  readonly activeOnly?: boolean;
}

export interface WriteTransaction {
  query<T>(sql: string, values?: readonly SqlValue[]): Promise<T[]>;
  run(sql: string, values?: readonly SqlValue[]): Promise<RunResult>;
  /** 单条或多条原始 SQL；DDL 也走这里，仍处于同一事务。 */
  exec(sql: string): Promise<void>;
  /** 业务写入与发件箱写入同事务：失败一起回滚，不留孤立的待同步操作。 */
  enqueue(operation: OutboxOperationInput): Promise<void>;
  /** 乐观锁更新：版本不匹配抛 `VersionConflictError`（409）。 */
  updateVersioned(spec: VersionedUpdateSpec): Promise<number>;
}

export interface DatabaseClient {
  readonly driverKind: string;
  /** 只读查询；写语句会被拒绝，防止绕过写锁与发件箱。 */
  query<T>(sql: string, values?: readonly SqlValue[]): Promise<T[]>;
  /** 全局单写者事务。回调内通过传入的 tx 查询和写入。 */
  withWriteTransaction<T>(callback: (tx: WriteTransaction) => Promise<T>): Promise<T>;
  /** 当前 epoch：换绑/重置后发件箱旧数据作废。 */
  currentEpoch(): Promise<number>;
  close(): Promise<void>;
}

export interface OpenDatabaseOptions {
  readonly driver: SqlDriver;
  /** 注入时钟，便于测试确定性。 */
  readonly now?: () => Date;
  /** 打开后是否执行迁移（默认 true）。 */
  readonly migrate?: boolean;
}

export interface DatabaseHandle extends DatabaseClient {
  setEpoch(epoch: number): Promise<void>;
}

const writer = new AsyncMutex();

class DatabaseImpl implements DatabaseHandle {
  private failure?: TransactionBrokenError;
  private closed = false;

  constructor(
    private readonly driver: SqlDriver,
    private readonly now: () => Date,
  ) {}

  get driverKind(): string {
    return this.driver.kind;
  }

  private assertOpen() {
    if (this.failure) throw this.failure;
    if (this.closed) throw new DatabaseError('INVALID_STATE', '数据库连接已关闭', 500);
  }

  async query<T>(sql: string, values: readonly SqlValue[] = []): Promise<T[]> {
    if (!isReadStatement(sql)) {
      throw new DatabaseError(
        'INVALID_STATE',
        'query 只接受只读语句；写操作必须走 withWriteTransaction',
        500,
      );
    }
    // Android 读取和写入共用连接。事务外的查询只能看到已提交数据。
    return writer.run(async () => {
      this.assertOpen();
      return this.driver.query<T>(sql, values);
    });
  }

  async currentEpoch(): Promise<number> {
    const [state] = await this.query<{ epoch: number }>(
      `SELECT "epoch" FROM "${SYNC_STATE_TABLE}" WHERE "id" = 1`,
    );
    return state?.epoch ?? 0;
  }

  async setEpoch(epoch: number): Promise<void> {
    await this.withWriteTransaction(async (tx) => {
      await tx.run(`UPDATE "${SYNC_STATE_TABLE}" SET "epoch" = ?, "updatedAt" = ? WHERE "id" = 1`, [
        epoch,
        this.now().toISOString(),
      ]);
    });
  }

  async close(): Promise<void> {
    await writer.run(async () => {
      if (this.closed) return;
      await this.driver.close?.();
      this.closed = true;
    });
  }

  async withWriteTransaction<T>(callback: (tx: WriteTransaction) => Promise<T>): Promise<T> {
    return writer.run(async () => {
      this.assertOpen();
      try {
        await this.driver.exec('BEGIN IMMEDIATE');
      } catch (error) {
        throw asDatabaseError(error);
      }
      const tx = new WriteTransactionImpl(this.driver, this.now);
      try {
        const result = await callback(tx);
        await this.driver.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          await this.driver.exec('ROLLBACK');
        } catch {
          this.failure = new TransactionBrokenError('写事务回滚失败，需重新打开数据库');
          throw this.failure;
        }
        if (error instanceof LocalApiError) throw error;
        throw asDatabaseError(error);
      } finally {
        tx.finish();
      }
    });
  }
}

class WriteTransactionImpl implements WriteTransaction {
  private active = true;

  constructor(
    private readonly driver: SqlDriver,
    private readonly now: () => Date,
  ) {}

  finish() {
    this.active = false;
  }

  private assertActive() {
    if (!this.active) throw new DatabaseError('INVALID_STATE', '写事务已结束', 500);
  }

  async query<T>(sql: string, values: readonly SqlValue[] = []): Promise<T[]> {
    this.assertActive();
    if (!isReadStatement(sql)) {
      throw new DatabaseError('INVALID_STATE', '事务内 query 只接受只读语句；写操作请用 run', 500);
    }
    return this.driver.query<T>(sql, values);
  }

  async run(sql: string, values: readonly SqlValue[] = []): Promise<RunResult> {
    this.assertActive();
    return this.driver.run(sql, values);
  }

  async exec(sql: string): Promise<void> {
    this.assertActive();
    return this.driver.exec(sql);
  }

  async enqueue(operation: OutboxOperationInput): Promise<void> {
    if (!SYNC_ENTITIES.has(operation.entity)) {
      throw new DatabaseError('INVALID_STATE', `不可同步的实体：${operation.entity}`, 422);
    }
    // delete 的唯一持久化证据是 deletedAt：其余列已由 entity/entityId/baseVersion 表达。
    // 在落库边界统一收紧，任何调用方传入的多余字段都不进发件箱。
    let payload = operation.payload as Record<string, unknown> | null | undefined;
    if (operation.kind === 'delete') {
      const deletedAt = payload?.deletedAt;
      if (typeof deletedAt !== 'string' || deletedAt.length === 0) {
        throw new DatabaseError('INVALID_STATE', 'delete 操作必须携带 deletedAt', 422);
      }
      payload = { deletedAt };
    }
    if (operation.kind === 'command') {
      if (SYNC_COMMAND_ENTITIES[operation.commandType] !== operation.entity) {
        throw new DatabaseError('INVALID_STATE', '同步命令与业务实体不匹配', 422);
      }
      if (operation.entity !== 'Ingredient') {
        const executedAt = operation.payload.executedAt;
        if (typeof executedAt !== 'string' || !Number.isFinite(Date.parse(executedAt))) {
          throw new DatabaseError('INVALID_STATE', '同步命令必须携带业务执行时间', 422);
        }
      }
    }
    const [state] = await this.query<{ epoch: number }>(
      `SELECT "epoch" FROM "${SYNC_STATE_TABLE}" WHERE "id" = 1`,
    );
    const epoch = state?.epoch ?? 0;
    const payloadJson = payload == null ? null : JSON.stringify(payload);
    const commandType = operation.kind === 'command' ? operation.commandType : null;
    const [existing] = await this.query<OutboxRow>(
      `SELECT "opId", "entity", "entityId", "kind", "commandType", "baseVersion", "payloadJson", "epoch"
       FROM "${SYNC_OUTBOX_TABLE}" WHERE "opId" = ?`,
      [operation.opId],
    );
    if (existing) {
      // 同一 opId 的重试必须逐字段等价：entity/entityId/kind/commandType/baseVersion/payload/epoch。
      // delete 载荷只比较 deletedAt：旧 v2 行可能保留 id/version 冗余列，语义相同即视为同一操作。
      const payloadMatches =
        operation.kind === 'delete'
          ? existing.kind === 'delete' &&
            deletedAtOf(existing.payloadJson) === deletedAtOf(payloadJson)
          : samePayload(existing.payloadJson, payloadJson);
      if (
        existing.entity !== operation.entity ||
        existing.entityId !== operation.entityId ||
        existing.epoch !== epoch ||
        existing.kind !== operation.kind ||
        existing.commandType !== commandType ||
        existing.baseVersion !== operation.baseVersion ||
        !payloadMatches
      ) {
        throw new DatabaseError('INVALID_STATE', '发件箱操作 ID 已用于不同写入', 409);
      }
      return;
    }

    const timestamp = this.now().toISOString();
    const payloadHash = payloadJson === null ? null : await hashPayload(payloadJson);
    // 严格 rowid FIFO：每次写入都追加一条，不做同实体合并，保证重放顺序与本地操作顺序一致。
    await this.run(
      `INSERT INTO "${SYNC_OUTBOX_TABLE}"
        ("id", "opId", "entity", "entityId", "kind", "commandType", "baseVersion", "payloadJson", "payloadHash", "epoch", "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        operation.opId,
        operation.opId,
        operation.entity,
        operation.entityId,
        operation.kind,
        commandType,
        operation.baseVersion,
        payloadJson,
        payloadHash,
        epoch,
        timestamp,
        timestamp,
      ],
    );
  }

  async updateVersioned(spec: VersionedUpdateSpec): Promise<number> {
    this.assertActive();
    if (!SYNC_ENTITIES.has(spec.table)) {
      throw new DatabaseError('INVALID_STATE', '无效的业务表', 422);
    }
    const activeOnly =
      spec.activeOnly !== false && spec.table !== 'Diner' && spec.table !== 'Settings';
    const where = `WHERE "id" = ?${activeOnly ? ' AND "deletedAt" IS NULL' : ''}`;
    const rows = await this.query<{ version: number }>(
      `SELECT "version" FROM "${spec.table}" ${where}`,
      [spec.id],
    );
    const current = rows[0];
    if (!current) {
      throw new DatabaseError('NOT_FOUND', `${spec.table} ${spec.id} 不存在`, 404);
    }
    if (current.version !== spec.expectedVersion) {
      throw new VersionConflictError(
        spec.table,
        String(spec.id),
        spec.expectedVersion,
        current.version,
      );
    }
    const columns = Object.entries(spec.values).filter(([, value]) => value !== undefined);
    const assignments = columns.map(([column]) => {
      if (!/^[A-Za-z_]\w*$/.test(column) || /^(id|version|updatedAt)$/i.test(column)) {
        throw new DatabaseError('INVALID_STATE', '无效的版本更新列', 422);
      }
      return `"${column}" = ?`;
    });
    assignments.push('"version" = "version" + 1', '"updatedAt" = ?');
    const result = await this.run(
      `UPDATE "${spec.table}" SET ${assignments.join(', ')} ${where} AND "version" = ?`,
      [
        ...columns.map(([, value]) => value as SqlValue),
        this.now().toISOString(),
        spec.id,
        spec.expectedVersion,
      ],
    );
    if (result.changes !== 1) {
      throw new VersionConflictError(
        spec.table,
        String(spec.id),
        spec.expectedVersion,
        current.version + 1,
      );
    }
    return spec.expectedVersion + 1;
  }
}

/** 在同一个写事务内检查版本、执行 DDL 并写入初始化状态。 */
export async function migrate(database: DatabaseClient, now = () => new Date()): Promise<void> {
  await database.withWriteTransaction(async (tx) => {
    const [version] = await tx.query<{ user_version: number }>('PRAGMA user_version');
    const current = version?.user_version ?? 0;
    if (current > SCHEMA_VERSION) {
      throw new DatabaseError(
        'SCHEMA',
        `库版本 ${current} 高于代码支持的 ${SCHEMA_VERSION}，拒绝打开`,
        500,
      );
    }
    if (current === SCHEMA_VERSION) return;
    if (current === 1) {
      for (const statement of MIGRATE_V1_TO_V2) await tx.exec(statement);
      await tx.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      return;
    }
    for (const statement of SCHEMA_DDL) await tx.exec(statement);

    const timestamp = now().toISOString();
    await tx.run(
      `INSERT INTO "${DEVICE_LOCAL_CONFIG_TABLE}" ("id", "updatedAt") VALUES (1, ?)
       ON CONFLICT ("id") DO NOTHING`,
      [timestamp],
    );
    await tx.run(
      `INSERT INTO "${SYNC_STATE_TABLE}" ("id", "epoch", "last_sync_seq", "updatedAt")
       VALUES (1, 0, NULL, ?)
       ON CONFLICT ("id") DO NOTHING`,
      [timestamp],
    );
    await tx.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
}

export async function openDatabase(options: OpenDatabaseOptions): Promise<DatabaseHandle> {
  const now = options.now ?? (() => new Date());
  const database = new DatabaseImpl(options.driver, now);
  if (options.migrate ?? true) await migrate(database, now);
  return database;
}
