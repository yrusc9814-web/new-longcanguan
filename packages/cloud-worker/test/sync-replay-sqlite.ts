import { DatabaseSync } from 'node:sqlite';

import { BUSINESS_INDEX_DDL, BUSINESS_TABLE_DDL } from '@dafan/shared/contracts';

type SqlValue = ArrayBuffer | string | number | null;

interface Cursor<T> extends Iterable<T> {
  toArray(): T[];
  one(): T;
  readonly rowsWritten: number;
  readonly columnNames: string[];
}

/**
 * 最小 `SqlStorage` 实现（Node 24 `node:sqlite`）。
 *
 * 只覆盖重放模块用到的 `exec(query, ...bindings)` →
 * `toArray()/one()/rowsWritten`，但保留真实 SQLite 语义（外键、唯一索引、
 * 部分唯一索引 `MealPlan_planDate_mealType_active_idx`）。
 */
export interface SqliteLedger {
  readonly sql: SqlStorage;
  readonly db: DatabaseSync;
  close(): void;
}

export function createLedger(): SqliteLedger {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  db.exec('PRAGMA foreign_keys = ON');
  for (const ddl of [...BUSINESS_TABLE_DDL, ...BUSINESS_INDEX_DDL]) db.exec(ddl);
  db.exec(
    `CREATE TABLE IF NOT EXISTS "ws_tickets" (
      "ticket_hash" TEXT NOT NULL PRIMARY KEY,
      "member_id" TEXT NOT NULL,
      "token_hash" TEXT NOT NULL,
      "expires_at" INTEGER NOT NULL,
      "created_at" INTEGER NOT NULL,
      "epoch" INTEGER NOT NULL DEFAULT 1
    )`,
  );

  function cursor<T>(array: T[], written: number): Cursor<T> {
    return {
      toArray: () => array,
      one: () => {
        if (!array.length) throw new Error('no rows');
        return array[0] as T;
      },
      rowsWritten: written,
      columnNames: array.length ? Object.keys(array[0] as object) : [],
      *[Symbol.iterator]() {
        yield* array;
      },
    };
  }

  function normalize(value: unknown): SqlValue {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number' || typeof value === 'string') return value;
    if (value instanceof ArrayBuffer) return value;
    throw new Error(`unsupported binding ${typeof value}`);
  }

  const sql = {
    exec<T extends Record<string, SqlValue>>(query: string, ...bindings: unknown[]): Cursor<T> {
      const statement = db.prepare(query);
      const params = bindings.map(normalize);
      if (/^\s*(SELECT|PRAGMA|WITH|VALUES)/i.test(query)) {
        return cursor(statement.all(...(params as never[])) as T[], 0);
      }
      const result = statement.run(...(params as never[]));
      return cursor([] as T[], Number(result.changes));
    },
  } as unknown as SqlStorage;

  return { sql, db, close: () => db.close() };
}
