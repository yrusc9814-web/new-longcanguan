/**
 * 本地账本读写原语：绑定配置、空库判定、27 表快照与「零回声」行应用。
 *
 * 铁律：从云端拉取/快照/恢复写入本地业务表时绝不写 `sync_outbox`
 * （否则每次拉取都会产生新的待推送操作，形成回声死循环）。
 */
import {
  SHOPPING_DEFAULT_LIST_ID,
  SHOPPING_DEFAULT_LIST_NAME,
  type HouseholdRole,
  type SyncRowChange,
} from '@dafan/shared/sync';

import type { DatabaseClient, WriteTransaction } from '../db/database.js';
import { BUSINESS_TABLES, SYNC_OUTBOX_TABLE, SYNC_STATE_TABLE } from '../db/schema.js';
import type { SqlValue } from '../db/types.js';

const CONFIG_TABLE = 'device_local_config';
const SET_TABLES = new Set<string>(BUSINESS_TABLES);

export interface LocalBinding {
  readonly cloudOrigin: string;
  readonly householdId: string;
  readonly memberId: string;
  readonly role: HouseholdRole;
  readonly generation: number;
}

interface ConfigRow {
  cloudOrigin: string | null;
  householdId: string | null;
  memberId: string | null;
  role: string | null;
  bindingGeneration: number;
}

export async function readBinding(
  database: Pick<DatabaseClient, 'query'>,
): Promise<LocalBinding | null> {
  const [row] = await database.query<ConfigRow>(
    `SELECT "cloudOrigin", "householdId", "memberId", "role", "bindingGeneration"
       FROM "${CONFIG_TABLE}" WHERE "id" = 1`,
  );
  if (!row?.cloudOrigin || !row.householdId || !row.memberId) return null;
  if (row.role !== 'OWNER' && row.role !== 'MEMBER') return null;
  return {
    cloudOrigin: row.cloudOrigin,
    householdId: row.householdId,
    memberId: row.memberId,
    role: row.role,
    generation: row.bindingGeneration,
  };
}

export interface BindingInput {
  readonly cloudOrigin: string;
  readonly householdId: string;
  readonly memberId: string;
  readonly role: HouseholdRole;
}

/** 写入绑定并推进代际；返回新代际。每次绑定/换绑都必须调用。 */
export async function writeBinding(
  database: DatabaseClient,
  input: BindingInput,
  now: () => Date,
): Promise<number> {
  return database.withWriteTransaction(async (tx) => {
    const [row] = await tx.query<{ generation: number }>(
      `SELECT "bindingGeneration" AS generation FROM "${CONFIG_TABLE}" WHERE "id" = 1`,
    );
    const generation = (row?.generation ?? 0) + 1;
    await tx.run(
      `UPDATE "${CONFIG_TABLE}"
          SET "cloudOrigin" = ?, "householdId" = ?, "memberId" = ?, "role" = ?,
              "bindingGeneration" = ?, "updatedAt" = ?
        WHERE "id" = 1`,
      [
        input.cloudOrigin,
        input.householdId,
        input.memberId,
        input.role,
        generation,
        now().toISOString(),
      ],
    );
    return generation;
  });
}

/** 解绑：清空云端身份，代际继续前进，旧代际在途响应一律失效。 */
export async function clearBinding(database: DatabaseClient, now: () => Date): Promise<number> {
  return database.withWriteTransaction(async (tx) => {
    const [row] = await tx.query<{ generation: number }>(
      `SELECT "bindingGeneration" AS generation FROM "${CONFIG_TABLE}" WHERE "id" = 1`,
    );
    const generation = (row?.generation ?? 0) + 1;
    await tx.run(
      `UPDATE "${CONFIG_TABLE}"
          SET "cloudOrigin" = NULL, "householdId" = NULL, "memberId" = NULL, "role" = NULL,
              "bindingGeneration" = ?, "updatedAt" = ?
        WHERE "id" = 1`,
      [generation, now().toISOString()],
    );
    return generation;
  });
}

export async function readRole(
  database: Pick<DatabaseClient, 'query'>,
): Promise<HouseholdRole | null> {
  const [row] = await database.query<{ role: string | null }>(
    `SELECT "role" FROM "${CONFIG_TABLE}" WHERE "id" = 1`,
  );
  return row?.role === 'OWNER' || row?.role === 'MEMBER' ? row.role : null;
}

interface SettingsRow {
  appName?: unknown;
  subtitle?: unknown;
  defaultPort?: unknown;
  autoBackupEnabled?: unknown;
  autoDeductInventory?: unknown;
  defaultRepeatDays?: unknown;
  version?: unknown;
}

interface ShoppingListRow {
  name?: unknown;
  status?: unknown;
  notes?: unknown;
  version?: unknown;
  deletedAt?: unknown;
}

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

/**
 * 空库判定：只允许「默认未改动的 Settings(id=1)」+「0 项的默认购物清单」，
 * 其余 25 张业务表全空。
 */
export async function isLedgerEmpty(database: Pick<DatabaseClient, 'query'>): Promise<boolean> {
  for (const table of BUSINESS_TABLES) {
    if (table === 'Settings') {
      const rows = await database.query<SettingsRow>('SELECT * FROM "Settings"');
      if (rows.length > 1) return false;
      const row = rows[0];
      if (!row) continue;
      if (row.appName !== undefined && row.appName !== '搭饭小馆') return false;
      if (row.subtitle !== undefined && row.subtitle !== '让每一餐都更美好') return false;
      if (row.defaultPort !== undefined && row.defaultPort !== 8787) return false;
      if (row.autoBackupEnabled !== undefined && !truthy(row.autoBackupEnabled)) return false;
      if (row.autoDeductInventory !== undefined && truthy(row.autoDeductInventory)) return false;
      if (row.defaultRepeatDays !== undefined && row.defaultRepeatDays !== 0) return false;
      if (row.version !== undefined && row.version !== 1) return false;
      continue;
    }
    if (table === 'ShoppingList') {
      const rows = await database.query<{ id: unknown } & ShoppingListRow>(
        'SELECT * FROM "ShoppingList"',
      );
      if (rows.length > 1) return false;
      const row = rows[0];
      if (!row) continue;
      if (row.id !== SHOPPING_DEFAULT_LIST_ID) return false;
      if (row.name !== SHOPPING_DEFAULT_LIST_NAME) return false;
      if (row.status !== 'ACTIVE') return false;
      if (row.notes !== null && row.notes !== undefined) return false;
      if (row.version !== undefined && row.version !== 1) return false;
      if (row.deletedAt !== null && row.deletedAt !== undefined) return false;
      const [count] = await database.query<{ c: number }>(
        'SELECT COUNT(*) AS c FROM "ShoppingListItem" WHERE "shoppingListId" = ?',
        [SHOPPING_DEFAULT_LIST_ID],
      );
      if ((count?.c ?? 0) > 0) return false;
      continue;
    }
    if (table === 'ShoppingListItem') continue; // 已由默认清单行数覆盖。
    const [count] = await database.query<{ c: number }>(`SELECT COUNT(*) AS c FROM "${table}"`);
    if ((count?.c ?? 0) > 0) return false;
  }
  return true;
}

export async function readTableRows(
  database: Pick<DatabaseClient, 'query'>,
  table: string,
): Promise<Record<string, unknown>[]> {
  assertBusinessTable(table);
  return database.query<Record<string, unknown>>(`SELECT * FROM "${table}" ORDER BY rowid`);
}

export async function readAllRows(
  database: Pick<DatabaseClient, 'query'>,
): Promise<{ table: string; rows: Record<string, unknown>[] }[]> {
  const result: { table: string; rows: Record<string, unknown>[] }[] = [];
  for (const table of BUSINESS_TABLES) {
    result.push({ table, rows: await readTableRows(database, table) });
  }
  return result;
}

export function assertBusinessTable(table: string): void {
  if (!SET_TABLES.has(table)) throw new Error(`未知的同步表：${table}`);
}

function normalizeValue(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return JSON.stringify(value);
}

export type ColumnCache = Map<string, Set<string>>;

export function createColumnCache(): ColumnCache {
  return new Map();
}

export async function tableColumns(
  database: Pick<DatabaseClient, 'query'>,
  cache: ColumnCache,
  table: string,
): Promise<Set<string>> {
  const cached = cache.get(table);
  if (cached) return cached;
  assertBusinessTable(table);
  const rows = await database.query<{ name: string }>(`PRAGMA table_info("${table}")`);
  const columns = new Set(rows.map((row) => row.name));
  if (columns.size === 0) throw new Error(`本地缺少业务表：${table}`);
  cache.set(table, columns);
  return columns;
}

/**
 * 在已打开的事务内按行应用云端数据。
 *
 * - `row === null`：物理删除；软删由服务端下发完整行表达，绝不在此推断。
 * - 其余：按主键原地更新，保留外键引用。
 *
 * 注意：事务内的一切查询必须走 `tx`；`DatabaseClient.query` 会排队等待同一把写锁，
 * 在事务回调里调用会自我死锁。
 */
export async function applyRowChanges(
  tx: WriteTransaction,
  cache: ColumnCache,
  changes: readonly SyncRowChange[],
): Promise<void> {
  if (changes.length === 0) return;
  await tx.exec('PRAGMA defer_foreign_keys = ON');
  for (const change of changes) {
    const table = String(change.table);
    if (!SET_TABLES.has(table)) continue;
    const columns = await tableColumns(tx, cache, table);
    if (change.row === null) {
      await tx.run(`DELETE FROM "${table}" WHERE "id" = ?`, [normalizeValue(change.id)]);
      continue;
    }
    const entries = Object.entries(change.row).filter(
      ([column]) => columns.has(column) && column !== undefined,
    );
    if (entries.length === 0) continue;
    const placeholders = entries.map(() => '?').join(', ');
    const updates = entries
      .filter(([column]) => column !== 'id')
      .map(([column]) => `"${column}" = excluded."${column}"`)
      .join(', ');
    await tx.run(
      `INSERT INTO "${table}" (${entries.map(([column]) => `"${column}"`).join(', ')})
       VALUES (${placeholders}) ON CONFLICT ("id") DO ${updates ? `UPDATE SET ${updates}` : 'NOTHING'}`,
      entries.map(([, value]) => normalizeValue(value)),
    );
  }
}

/** 外键依赖排序：父表先于子表。 */
export async function tableOrder(database: Pick<DatabaseClient, 'query'>): Promise<string[]> {
  const dependencies = new Map<string, Set<string>>();
  for (const table of BUSINESS_TABLES) {
    const foreignKeys = await database.query<{ table: string }>(
      `PRAGMA foreign_key_list("${table}")`,
    );
    dependencies.set(table, new Set(foreignKeys.map((key) => key.table)));
  }
  const ordered: string[] = [];
  while (dependencies.size > 0) {
    const ready = [...dependencies].filter(([, parents]) =>
      [...parents].every((parent) => parent === undefined || ordered.includes(parent)),
    );
    if (ready.length === 0) throw new Error('业务表外键顺序不可解析');
    for (const [table] of ready) {
      ordered.push(table);
      dependencies.delete(table);
    }
  }
  return ordered;
}

/** 整库替换（快照/云端恢复）：单事务内清空 27 表并写入新行。 */
export async function replaceAllRows(
  database: DatabaseClient,
  cache: ColumnCache,
  tables: readonly { table: string; rows: readonly Record<string, unknown>[] }[],
  state: { epoch: number; seq: number },
  options: { readonly clearOutbox?: boolean } = {},
): Promise<number> {
  const ordered = await tableOrder(database);
  // 列集合必须在事务外预热：事务内不能再走 DatabaseClient.query（同一写锁会死锁）。
  await Promise.all(ordered.map((table) => tableColumns(database, cache, table)));
  const byTable = new Map(tables.map((entry) => [entry.table, entry.rows]));
  return database.withWriteTransaction(async (tx) => {
    await tx.exec('PRAGMA defer_foreign_keys = ON');
    for (const table of [...ordered].reverse()) await tx.run(`DELETE FROM "${table}"`);
    let written = 0;
    for (const table of ordered) {
      const rows = byTable.get(table) ?? [];
      const columns = await tableColumns(tx, cache, table);
      for (const row of rows) {
        const entries = Object.entries(row).filter(([column]) => columns.has(column));
        if (entries.length === 0) continue;
        await tx.run(
          `INSERT OR REPLACE INTO "${table}" (${entries.map(([column]) => `"${column}"`).join(', ')})
           VALUES (${entries.map(() => '?').join(', ')})`,
          entries.map(([, value]) => normalizeValue(value)),
        );
        written += 1;
      }
    }
    await writeSyncState(tx, state.epoch, state.seq);
    // 与整库替换同事务：要么新库 + 空发件箱，要么全不生效（不留旧 opId 在新库上重推）。
    if (options.clearOutbox) await tx.run(`DELETE FROM "${SYNC_OUTBOX_TABLE}"`);
    return written;
  });
}

export async function readSyncState(
  database: Pick<DatabaseClient, 'query'>,
): Promise<{ epoch: number; lastSeq: number }> {
  const [row] = await database.query<{ epoch: number; last_sync_seq: string | null }>(
    `SELECT "epoch", "last_sync_seq" FROM "${SYNC_STATE_TABLE}" WHERE "id" = 1`,
  );
  const seq = Number(row?.last_sync_seq ?? 0);
  return {
    epoch: row?.epoch ?? 0,
    lastSeq: Number.isSafeInteger(seq) && seq > 0 ? seq : 0,
  };
}

export async function writeSyncState(
  tx: Pick<WriteTransaction, 'run'>,
  epoch: number,
  seq: number,
  now: () => Date = () => new Date(),
): Promise<void> {
  await tx.run(
    `UPDATE "${SYNC_STATE_TABLE}"
        SET "epoch" = ?, "last_sync_seq" = ?, "updatedAt" = ? WHERE "id" = 1`,
    [epoch, String(seq), now().toISOString()],
  );
}

export async function clearOutbox(
  tx: Pick<WriteTransaction, 'run'>,
  predicate: 'all' | 'epoch' = 'all',
  epoch?: number,
): Promise<void> {
  if (predicate === 'all') {
    await tx.run(`DELETE FROM "${SYNC_OUTBOX_TABLE}"`);
    return;
  }
  await tx.run(`DELETE FROM "${SYNC_OUTBOX_TABLE}" WHERE "epoch" <> ?`, [epoch ?? -1]);
}

export interface OutboxRow {
  readonly id: string;
  readonly opId: string;
  readonly entity: string;
  readonly entityId: string;
  readonly kind: 'upsert' | 'delete' | 'command';
  readonly commandType: string | null;
  readonly baseVersion: number | null;
  readonly payloadJson: string | null;
  readonly payloadHash: string | null;
  readonly epoch: number;
  readonly state: string;
  readonly attemptCount: number;
}

export async function pendingOutbox(
  database: Pick<DatabaseClient, 'query'>,
  epoch: number,
  limit: number,
): Promise<OutboxRow[]> {
  return database.query<OutboxRow>(
    `SELECT "id","opId","entity","entityId","kind","commandType","baseVersion","payloadJson",
            "payloadHash","epoch","state","attemptCount"
       FROM "${SYNC_OUTBOX_TABLE}"
      WHERE "epoch" = ? AND "state" IN ('pending','inflight')
      ORDER BY rowid LIMIT ?`,
    [epoch, limit],
  );
}

export async function outboxCount(
  database: Pick<DatabaseClient, 'query'>,
  epoch?: number,
): Promise<number> {
  const rows =
    epoch === undefined
      ? await database.query<{ c: number }>(`SELECT COUNT(*) AS c FROM "${SYNC_OUTBOX_TABLE}"`)
      : await database.query<{ c: number }>(
          `SELECT COUNT(*) AS c FROM "${SYNC_OUTBOX_TABLE}" WHERE "epoch" = ?`,
          [epoch],
        );
  return rows[0]?.c ?? 0;
}

/** 存在本地未确认写入的 (entity, entityId) 集合：拉取时这些行不得被远端覆盖。 */
export async function pendingEntityKeys(
  database: Pick<DatabaseClient, 'query'>,
  epoch: number,
): Promise<Set<string>> {
  const rows = await database.query<{ entity: string; entityId: string }>(
    `SELECT DISTINCT "entity", "entityId" FROM "${SYNC_OUTBOX_TABLE}" WHERE "epoch" = ?`,
    [epoch],
  );
  return new Set(rows.map((row) => `${row.entity}:${row.entityId}`));
}

/** 删除指定操作，以及同一实体的全部后继操作（版本链已断，后继必失败）。 */
export async function dropOperationChain(
  tx: WriteTransaction,
  target: { opId: string; entity: string; entityId: string },
): Promise<string[]> {
  const [targetRow] = await tx.query<{ rowid: number }>(
    `SELECT rowid FROM "${SYNC_OUTBOX_TABLE}" WHERE "opId" = ?`,
    [target.opId],
  );
  const rows = await tx.query<{ opId: string; rowid: number }>(
    `SELECT "opId", rowid FROM "${SYNC_OUTBOX_TABLE}"
      WHERE "entity" = ? AND "entityId" = ? AND rowid >= ? ORDER BY rowid`,
    [target.entity, target.entityId, targetRow?.rowid ?? 0],
  );
  const opIds = rows.map((row) => row.opId);
  for (const opId of opIds) {
    await tx.run(`DELETE FROM "${SYNC_OUTBOX_TABLE}" WHERE "opId" = ?`, [opId]);
  }
  return opIds;
}

/** 删除单条操作（不连带后继）。 */
export async function dropOperation(
  tx: Pick<WriteTransaction, 'run'>,
  opId: string,
): Promise<void> {
  await tx.run(`DELETE FROM "${SYNC_OUTBOX_TABLE}" WHERE "opId" = ?`, [opId]);
}

export { BUSINESS_TABLES };
