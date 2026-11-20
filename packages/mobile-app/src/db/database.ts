import type { RETAINED_MODELS } from '@dafan/shared/contracts';

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
  SCHEMA_DDL,
  SCHEMA_VERSION,
  SYNC_OUTBOX_TABLE,
  SYNC_STATE_TABLE,
} from './schema';
import type { RunResult, SqlDriver, SqlValue } from './types';
import { isReadStatement } from './types';

export type SyncEntityName = (typeof RETAINED_MODELS)[number];

const SYNC_ENTITIES = new Set<string>(BUSINESS_TABLES);

/** 发件箱入参：字段与 shared `SyncOperation` 对齐，并额外携带 payload。 */
export interface OutboxOperationInput {
  /** 幂等键；同一操作的多次重试必须复用同一 opId。 */
  readonly opId: string;
  readonly entity: SyncEntityName;
  readonly entityId: string;
  readonly kind: 'upsert' | 'delete';
  readonly baseVersion: number | null;
  readonly payload?: Record<string, unknown> | null;
}

export interface VersionedUpdateSpec {
  readonly table: SyncEntityName;
  readonly id: string;
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
    const [state] = await this.query<{ epoch: number }>(
      `SELECT "epoch" FROM "${SYNC_STATE_TABLE}" WHERE "id" = 1`,
    );
    const timestamp = this.now().toISOString();
    await this.run(
      `INSERT INTO "${SYNC_OUTBOX_TABLE}"
        ("id", "opId", "entity", "entityId", "kind", "baseVersion", "payloadJson", "epoch", "state", "attemptCount", "lastError", "nextAttemptAt", "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?)
       ON CONFLICT ("entity", "entityId") DO UPDATE SET
         "opId" = excluded."opId",
         "kind" = excluded."kind",
         "baseVersion" = excluded."baseVersion",
         "payloadJson" = excluded."payloadJson",
         "epoch" = excluded."epoch",
         "state" = 'pending',
         "attemptCount" = 0,
         "lastError" = NULL,
         "nextAttemptAt" = NULL,
         "updatedAt" = excluded."updatedAt"`,
      [
        operation.opId,
        operation.opId,
        operation.entity,
        operation.entityId,
        operation.kind,
        operation.baseVersion,
        operation.payload == null ? null : JSON.stringify(operation.payload),
        state?.epoch ?? 0,
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
    const activeOnly = spec.activeOnly ?? true;
    const rows = await this.query<{ version: number }>(
      activeOnly
        ? `SELECT "version" FROM "${spec.table}" WHERE "id" = ? AND "deletedAt" IS NULL`
        : `SELECT "version" FROM "${spec.table}" WHERE "id" = ?`,
      [spec.id],
    );
    const current = rows[0];
    if (!current) {
      throw new DatabaseError('NOT_FOUND', `${spec.table} ${spec.id} 不存在`, 404);
    }
    if (current.version !== spec.expectedVersion) {
      throw new VersionConflictError(spec.table, spec.id, spec.expectedVersion, current.version);
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
      `UPDATE "${spec.table}" SET ${assignments.join(', ')} WHERE "id" = ? AND "version" = ?`,
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
        spec.id,
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
