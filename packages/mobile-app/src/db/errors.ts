/** 数据库层错误：统一带 `statusCode`，便于上层直接映射 HTTP 响应。 */

export type DatabaseErrorCode =
  'VERSION_CONFLICT' | 'NOT_FOUND' | 'INVALID_STATE' | 'BUSY' | 'SCHEMA';

export class DatabaseError extends Error {
  constructor(
    readonly code: DatabaseErrorCode,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'DatabaseError';
  }
}

/** 乐观锁冲突：语义与后端 `VersionConflictError` 一致，供上层映射 409。 */
export class VersionConflictError extends DatabaseError {
  constructor(
    readonly entity: string,
    readonly id: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super('VERSION_CONFLICT', '数据已在其他设备修改', 409);
    this.name = 'VersionConflictError';
  }
}

/** 写事务失败且回滚也失败：连接已不可信，必须关闭重开。 */
export class TransactionBrokenError extends DatabaseError {
  constructor(message: string) {
    super('INVALID_STATE', message, 500);
    this.name = 'TransactionBrokenError';
  }
}

/** 把驱动错误收敛成带 HTTP 语义的数据库错误：BUSY → 503，其余 → 500。 */
export function asDatabaseError(error: unknown): DatabaseError {
  if (error instanceof DatabaseError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/database is locked|SQLITE_BUSY|busy/i.test(message)) {
    return new DatabaseError('BUSY', message, 503);
  }
  return new DatabaseError('INVALID_STATE', message, 500);
}
