import { openCapacitorDriver, type CapacitorDriverOptions } from './capacitor-driver';
import {
  openDatabase,
  type DatabaseClient,
  type DatabaseHandle,
  type OutboxOperationInput,
  type VersionedUpdateSpec,
  type WriteTransaction,
} from './database';

export * from './capacitor-driver';
export * from './database';
export * from './errors';
export * from './mutex';
export * from './schema';
export * from './types';

export interface CapacitorDatabaseOptions extends Omit<CapacitorDriverOptions, 'plugin'> {
  readonly plugin: CapacitorDriverOptions['plugin'];
  readonly now?: () => Date;
}

export interface CapacitorDatabase extends DatabaseClient {
  /** 测试/诊断用：底层句柄（含读版本、epoch 等）。 */
  readonly handle: DatabaseHandle;
}

/**
 * 打开 Android 离线库：建连接 → 打开 → 设 WAL/外键 → 迁移 → 返回带 query /
 * withWriteTransaction 的客户端。
 *
 * 调用方拿到的是唯一入口：所有读走 `query`，所有写走 `withWriteTransaction`，
 * 业务写与 sync_outbox 在同一事务内提交。
 */
export async function openCapacitorDatabase(
  options: CapacitorDatabaseOptions,
): Promise<CapacitorDatabase> {
  const driver = await openCapacitorDriver(options);
  let handle: DatabaseHandle;
  try {
    handle = await openDatabase({ driver, now: options.now });
  } catch (error) {
    await driver.close?.().catch(() => undefined);
    throw error;
  }
  return {
    handle,
    get driverKind() {
      return handle.driverKind;
    },
    query: handle.query.bind(handle),
    withWriteTransaction: handle.withWriteTransaction.bind(handle),
    currentEpoch: handle.currentEpoch.bind(handle),
    close: handle.close.bind(handle),
  };
}

export type { DatabaseClient, OutboxOperationInput, VersionedUpdateSpec, WriteTransaction };
