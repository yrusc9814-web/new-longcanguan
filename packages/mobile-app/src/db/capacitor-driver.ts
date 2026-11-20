import { asDatabaseError } from './errors';
import type { RunResult, SqlDriver, SqlValue } from './types';

const EMPTY_VALUES: readonly SqlValue[] = [];

/** 布尔值统一成 1/0：Capacitor 原生绑参不接受 JS boolean。 */
function normalizeValues(values: readonly SqlValue[] = EMPTY_VALUES): SqlValue[] {
  return values.map((value) => (typeof value === 'boolean' ? (value ? 1 : 0) : value));
}

/**
 * Capacitor 插件最小可用面。
 *
 * 只声明驱动真正调用的方法，测试可用同形假插件替换；真实插件见
 * `@capacitor-community/sqlite@7.0.3` 的 `CapacitorSQLitePlugin`。
 */
export interface CapacitorSqlitePluginLike {
  createConnection(options: {
    database: string;
    version: number;
    encrypted: boolean;
    mode: string;
    readonly: boolean;
  }): Promise<unknown>;
  open(options: { database: string; readonly: boolean }): Promise<unknown>;
  closeConnection(options: { database: string; readonly: boolean }): Promise<unknown>;
  execute(options: {
    database: string;
    statements: string;
    transaction: boolean;
    readonly: boolean;
  }): Promise<{ changes?: { changes?: number } }>;
  run(options: {
    database: string;
    statement: string;
    values: SqlValue[];
    transaction: boolean;
    readonly: boolean;
  }): Promise<{ changes?: { changes?: number; lastId?: number } }>;
  query(options: {
    database: string;
    statement: string;
    values: SqlValue[];
    readonly: boolean;
  }): Promise<{ values?: unknown[] }>;
}

export interface CapacitorDriverOptions {
  readonly databaseName?: string;
  readonly plugin: CapacitorSqlitePluginLike;
  readonly version?: number;
}

export const DEFAULT_DATABASE_NAME = 'dafan';

/**
 * Android `@capacitor-community/sqlite` 驱动。
 *
 * 关键约束（由 7.0.3 原生实现决定，见 android/.../Database.java）：
 * - `execute` / `run` / `executeSet` 默认各自包一层隐式事务（`transaction` 缺省 true），
 *   所以本驱动的写调用一律显式 `transaction: false`，事务边界只由 withWriteTransaction 的
 *   BEGIN IMMEDIATE/COMMIT 控制；否则外层 BEGIN 之后的每条语句都会被插件再套一层事务；
 * - 读一律走 `query`，绝不用 `executeSet`（executeSet 面向批量写，且会自行开事务）；
 * - 单条 `run` 必须显式传 `values` 数组（插件缺 `values` 时直接拒绝调用）。
 */
export function createCapacitorDriver(
  options: CapacitorDriverOptions,
  state: { opened: boolean } = { opened: false },
): SqlDriver & { markOpened(): void } {
  const database = options.databaseName ?? DEFAULT_DATABASE_NAME;
  const plugin = options.plugin;

  return {
    kind: 'capacitor-sqlite@7.0.3',
    markOpened() {
      state.opened = true;
    },
    async query<T>(sql: string, values: readonly SqlValue[] = EMPTY_VALUES): Promise<T[]> {
      const result = await plugin.query({
        database,
        statement: sql,
        values: normalizeValues(values),
        readonly: false,
      });
      return (result.values ?? []) as T[];
    },
    async run(sql: string, values: readonly SqlValue[] = EMPTY_VALUES): Promise<RunResult> {
      const result = await plugin.run({
        database,
        statement: sql,
        values: normalizeValues(values),
        transaction: false,
        readonly: false,
      });
      return {
        changes: result.changes?.changes ?? 0,
        lastInsertRowid: result.changes?.lastId ?? 0,
      };
    },
    async exec(sql: string): Promise<void> {
      await plugin.execute({ database, statements: sql, transaction: false, readonly: false });
    },
    async close(): Promise<void> {
      if (!state.opened) return;
      await plugin.closeConnection({ database, readonly: false });
      state.opened = false;
    },
  };
}

/** 建连接、打开并初始化 PRAGMA，返回驱动。失败统一收敛成 DatabaseError（BUSY → 503）。 */
export async function openCapacitorDriver(options: CapacitorDriverOptions): Promise<SqlDriver> {
  const database = options.databaseName ?? DEFAULT_DATABASE_NAME;
  try {
    await options.plugin.createConnection({
      database,
      version: options.version ?? 1,
      encrypted: false,
      mode: 'no-encryption',
      readonly: false,
    });
    const driver = createCapacitorDriver(options);
    driver.markOpened();
    try {
      await options.plugin.open({ database, readonly: false });
      // journal_mode returns a row. Android's execute rejects row-producing statements.
      const [journal] = await driver.query<{ journal_mode: string }>('PRAGMA journal_mode = WAL');
      await driver.exec('PRAGMA foreign_keys = ON');
      const [foreignKeys] = await driver.query<{ foreign_keys: number }>('PRAGMA foreign_keys');
      if (journal?.journal_mode !== 'wal' || foreignKeys?.foreign_keys !== 1) {
        throw new Error('SQLite did not enable WAL and foreign key enforcement');
      }
      return driver;
    } catch (error) {
      await driver.close?.().catch(() => undefined);
      throw error;
    }
  } catch (error) {
    throw asDatabaseError(error);
  }
}
