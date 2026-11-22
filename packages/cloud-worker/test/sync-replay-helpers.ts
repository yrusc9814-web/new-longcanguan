import type { SyncEntityName, SyncOperation, SyncPayload } from '@dafan/shared/sync';
import { SHOPPING_DEFAULT_LIST_ID, SHOPPING_DEFAULT_LIST_NAME } from '@dafan/shared/sync';

import { openDatabase, type DatabaseHandle } from '../../mobile-app/src/db/database.js';
import { createNodeSqliteDriver } from '../../mobile-app/tests/helpers/node-sqlite-driver.js';
import { createLedger } from './sync-replay-sqlite';
import { clearReplayHistory, migrateReplay, replayOperation } from '../src/sync-replay';

export const NOW = new Date('2026-11-21T08:00:00.000Z');

export interface Ledger {
  readonly sql: SqlStorage;
  readonly db: import('node:sqlite').DatabaseSync;
  close(): void;
}

export function ledger(): Ledger {
  const created = createLedger();
  migrateReplay(created.sql);
  // 与真实 DO 迁移一致的种子：Settings(id=1) 与默认活跃购物单。
  const timestamp = '2026-11-20T00:00:00.000Z';
  created.sql.exec(
    `INSERT INTO "Settings" ("id","appName","subtitle","defaultPort","autoBackupEnabled",
       "autoDeductInventory","defaultRepeatDays","version","createdAt","updatedAt")
     VALUES (1, '搭饭小馆', '让每一餐都更美好', 8787, 1, 0, 0, 1, ?, ?)`,
    timestamp,
    timestamp,
  );
  created.sql.exec(
    `INSERT INTO "ShoppingList" ("id","name","status","notes","version","deletedAt","createdAt","updatedAt")
     VALUES (?, ?, 'ACTIVE', NULL, 1, NULL, ?, ?)`,
    SHOPPING_DEFAULT_LIST_ID,
    SHOPPING_DEFAULT_LIST_NAME,
    timestamp,
    timestamp,
  );
  return created;
}

export async function mobile(): Promise<DatabaseHandle> {
  return openDatabase({
    driver: createNodeSqliteDriver({ path: ':memory:' }),
    now: () => NOW,
  });
}

interface OutboxRow {
  opId: string;
  entity: SyncEntityName;
  entityId: string;
  kind: 'upsert' | 'delete' | 'command';
  commandType: string | null;
  baseVersion: number | null;
  payloadJson: string | null;
  payloadHash: string | null;
  epoch: number;
}

export async function outbox(db: DatabaseHandle): Promise<OutboxRow[]> {
  return db.query<OutboxRow>(
    `SELECT "opId","entity","entityId","kind","commandType","baseVersion","payloadJson","payloadHash","epoch"
     FROM "sync_outbox" ORDER BY rowid`,
  );
}

export function toOperation(row: OutboxRow): SyncOperation {
  const payload = row.payloadJson
    ? (JSON.parse(row.payloadJson) as Record<string, unknown>)
    : ({} as Record<string, unknown>);
  const body = payload as unknown as SyncPayload;
  const base = { id: row.opId, entity: row.entity, entityId: row.entityId };
  if (row.kind === 'upsert') {
    return { ...base, kind: 'upsert', baseVersion: row.baseVersion, payload: body };
  }
  if (row.kind === 'delete') {
    return {
      ...base,
      kind: 'delete',
      baseVersion: row.baseVersion as number,
      deletedAt: String(payload.deletedAt),
    };
  }
  return {
    ...base,
    kind: 'command',
    commandType: row.commandType as never,
    baseVersion: row.baseVersion as never,
    payload: body,
    payloadHash: row.payloadHash ?? '',
  } as SyncOperation;
}

/** 按发件箱 rowid 顺序重放；返回每条操作的结果。 */
export function replayAll(
  target: Ledger,
  operations: readonly SyncOperation[],
): ReturnType<typeof replayOperation>[] {
  return operations.map((operation) => replayOperation(target.sql, operation));
}

export function tableRows(target: Ledger, table: SyncEntityName): Record<string, unknown>[] {
  return target.sql.exec(`SELECT * FROM "${table}" ORDER BY "id"`).toArray() as unknown as Record<
    string,
    unknown
  >[];
}

export async function mobileRows(
  db: DatabaseHandle,
  table: SyncEntityName,
  orderBy = '"id"',
): Promise<Record<string, unknown>[]> {
  return db.query<Record<string, unknown>>(`SELECT * FROM "${table}" ORDER BY ${orderBy}`);
}

/** 只保留列出的列，便于逐列比对（忽略端侧私有列）。 */
export function pick(
  rows: readonly Record<string, unknown>[],
  columns: readonly string[],
): Record<string, unknown>[] {
  return rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));
}

export function resetLedger(target: Ledger): void {
  clearReplayHistory(target.sql);
  const tables = target.sql
    .exec<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )
    .toArray();
  for (const { name } of tables) {
    if (name === 'sync_replay_history') continue;
    target.sql.exec(`DELETE FROM "${name}"`);
  }
}

export const DEFAULT_SETTINGS = {
  id: 1,
  appName: '搭饭小馆',
  subtitle: '让每一餐都更美好',
  defaultPort: 8787,
  autoBackupEnabled: 1,
  autoDeductInventory: 0,
  defaultRepeatDays: 0,
  version: 1,
};

export const DEFAULT_LIST = {
  id: SHOPPING_DEFAULT_LIST_ID,
  name: SHOPPING_DEFAULT_LIST_NAME,
  status: 'ACTIVE',
  notes: null,
  version: 1,
  deletedAt: null,
};
