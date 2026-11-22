import {
  SHOPPING_DEFAULT_LIST_ID,
  SHOPPING_DEFAULT_LIST_NAME,
  SYNC_SNAPSHOT_TABLES,
  type SyncEntityName,
  type SyncPayload,
  type SyncRowChange,
  type SyncSnapshotPage,
  type SyncSnapshotUpload,
  type SyncSnapshotUploadResult,
} from '@dafan/shared/sync';

import { clearReplayHistory, migrateReplay } from './sync-replay';

const SESSION_TTL_MS = 30 * 60 * 1000;
const SNAPSHOT_BYTE_BUDGET = 2_000_000;
const tables = new Set<string>(SYNC_SNAPSHOT_TABLES);

export const SYNC_STORAGE_DDL = [
  `CREATE TABLE IF NOT EXISTS processed_ops (
    epoch INTEGER NOT NULL, client_id TEXT NOT NULL, op_id TEXT NOT NULL,
    member_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    ack_seq INTEGER NOT NULL, new_version INTEGER NOT NULL,
    PRIMARY KEY (epoch, client_id, op_id)
  )`,
  `CREATE TABLE IF NOT EXISTS sync_journal_rows (
    epoch INTEGER NOT NULL, sync_seq INTEGER NOT NULL, row_index INTEGER NOT NULL,
    change_json TEXT NOT NULL, PRIMARY KEY (epoch, sync_seq, row_index)
  )`,
  `CREATE TABLE IF NOT EXISTS sync_snapshots (
    id TEXT PRIMARY KEY, member_id TEXT NOT NULL, epoch INTEGER NOT NULL,
    seq INTEGER NOT NULL, empty INTEGER NOT NULL, expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sync_snapshot_rows (
    snapshot_id TEXT NOT NULL REFERENCES sync_snapshots(id) ON DELETE CASCADE,
    position INTEGER NOT NULL, table_name TEXT NOT NULL, row_json TEXT NOT NULL,
    PRIMARY KEY (snapshot_id, position)
  )`,
  `CREATE TABLE IF NOT EXISTS sync_uploads (
    id TEXT PRIMARY KEY, member_id TEXT NOT NULL, epoch INTEGER NOT NULL,
    action TEXT NOT NULL, next_page INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    result_json TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sync_upload_pages (
    upload_id TEXT NOT NULL REFERENCES sync_uploads(id) ON DELETE CASCADE,
    page INTEGER NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY (upload_id, page)
  )`,
  `CREATE TABLE IF NOT EXISTS sync_upload_rows (
    upload_id TEXT NOT NULL REFERENCES sync_uploads(id) ON DELETE CASCADE,
    table_name TEXT NOT NULL, row_id TEXT NOT NULL, row_json TEXT NOT NULL,
    PRIMARY KEY (upload_id, table_name, row_id)
  )`,
];

export function migrateSyncStorage(sql: SqlStorage) {
  for (const statement of SYNC_STORAGE_DDL) sql.exec(statement);
  migrateReplay(sql);
  const columns = sql.exec<{ name: string }>('PRAGMA table_info(ws_tickets)').toArray();
  if (!columns.some(({ name }) => name === 'epoch')) {
    sql.exec('ALTER TABLE ws_tickets ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1');
  }
}

export class InvalidSyncData extends Error {}
export class SyncStateConflict extends Error {}

export function currentSeq(sql: SqlStorage, epoch: number): number {
  return sql
    .exec<{ seq: number }>(
      'SELECT COALESCE(MAX(sync_seq), 0) AS seq FROM sync_log WHERE epoch = ?',
      epoch,
    )
    .one().seq;
}

export function writeJournal(
  sql: SqlStorage,
  epoch: number,
  seq: number,
  memberId: string,
  opId: string,
  entity: SyncEntityName,
  id: string,
  kind: string,
  version: number,
  changes: readonly SyncRowChange[],
): void {
  sql.exec(
    `INSERT INTO sync_log
    (epoch, sync_seq, entity, entity_id, kind, version, actor_member_id, operation_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    epoch,
    seq,
    entity,
    id,
    kind,
    version,
    memberId,
    opId,
  );
  changes.forEach((change, index) => {
    sql.exec(
      'INSERT INTO sync_journal_rows VALUES (?, ?, ?, ?)',
      epoch,
      seq,
      index,
      JSON.stringify(change),
    );
  });
}

export function isEmptyLedger(sql: SqlStorage): boolean {
  if (
    sql
      .exec(
        `SELECT 1 FROM Settings WHERE id = 1 AND version = 1
      AND appName = '搭饭小馆' AND subtitle = '让每一餐都更美好' AND defaultPort = 8787
      AND autoBackupEnabled = 1 AND autoDeductInventory = 0 AND defaultRepeatDays = 0`,
      )
      .toArray().length !== 1 ||
    sql
      .exec(
        `SELECT 1 FROM ShoppingList WHERE id = ? AND name = ? AND version = 1
      AND status = 'ACTIVE' AND notes IS NULL AND deletedAt IS NULL`,
        SHOPPING_DEFAULT_LIST_ID,
        SHOPPING_DEFAULT_LIST_NAME,
      )
      .toArray().length !== 1
  )
    return false;

  return SYNC_SNAPSHOT_TABLES.every((table) => {
    const predicate = table === 'Settings' || table === 'ShoppingList' ? ' WHERE id <> ?' : '';
    const bindings =
      table === 'Settings' ? [1] : table === 'ShoppingList' ? [SHOPPING_DEFAULT_LIST_ID] : [];
    return !sql.exec(`SELECT 1 FROM "${table}"${predicate} LIMIT 1`, ...bindings).toArray().length;
  });
}

export function isSyncTable(value: unknown): value is SyncEntityName {
  return typeof value === 'string' && tables.has(value);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function quote(name: string) {
  return `"${name.replaceAll('"', '""')}"`;
}

function tableColumns(sql: SqlStorage, table: SyncEntityName): string[] {
  return sql
    .exec<{ name: string }>(`PRAGMA table_info(${quote(table)})`)
    .toArray()
    .map(({ name }) => name);
}

type SnapshotAnchor = {
  id: string;
  epoch: number;
  seq: number;
  empty: number;
};

export function readSnapshot(
  sql: SqlStorage,
  memberId: string,
  epoch: number,
  cursor: string | null,
  limit: number,
): SyncSnapshotPage | null {
  const now = Date.now();
  sql.exec('DELETE FROM sync_snapshots WHERE expires_at <= ?', now);
  let anchor: SnapshotAnchor | undefined;
  let after = 0;
  if (cursor) {
    const match = /^([0-9a-f-]{36})\.(\d+)$/.exec(cursor);
    if (!match || !Number.isSafeInteger(Number(match[2]))) throw new InvalidSyncData();
    after = Number(match[2]);
    anchor = sql
      .exec<SnapshotAnchor>(
        'SELECT id, epoch, seq, empty FROM sync_snapshots WHERE id = ? AND member_id = ? AND epoch = ?',
        match[1],
        memberId,
        epoch,
      )
      .toArray()[0];
    if (!anchor) return null;
    sql.exec(
      'UPDATE sync_snapshots SET expires_at = ? WHERE id = ?',
      now + SESSION_TTL_MS,
      anchor.id,
    );
  } else {
    const id = crypto.randomUUID();
    anchor = { id, epoch, seq: currentSeq(sql, epoch), empty: Number(isEmptyLedger(sql)) };
    // Bound the number of materialized views while still allowing concurrent/retried downloads.
    sql.exec(
      `DELETE FROM sync_snapshots WHERE id IN (
      SELECT id FROM sync_snapshots WHERE member_id = ? ORDER BY expires_at DESC, id LIMIT -1 OFFSET 3
    )`,
      memberId,
    );
    sql.exec(
      'INSERT INTO sync_snapshots VALUES (?, ?, ?, ?, ?, ?)',
      id,
      memberId,
      epoch,
      anchor.seq,
      anchor.empty,
      now + SESSION_TTL_MS,
    );
    let offset = 0;
    for (const table of SYNC_SNAPSHOT_TABLES) {
      const fields = tableColumns(sql, table)
        .map((name) => `'${name}', ${quote(name)}`)
        .join(', ');
      offset += sql.exec(
        `INSERT INTO sync_snapshot_rows (snapshot_id, position, table_name, row_json)
         SELECT ?, ? + ROW_NUMBER() OVER (ORDER BY id), ?, json_object(${fields}) FROM ${quote(table)}`,
        id,
        offset,
        table,
      ).rowsWritten;
    }
  }

  const rows: SyncRowChange[] = [];
  let bytes = 0;
  let more = false;
  let position = after;
  for (const entry of sql.exec<{ position: number; table_name: SyncEntityName; row_json: string }>(
    `SELECT position, table_name, row_json FROM sync_snapshot_rows
     WHERE snapshot_id = ? AND position > ? ORDER BY position LIMIT ?`,
    anchor.id,
    after,
    limit + 1,
  )) {
    // Conservative UTF-8 bound, avoiding an extra allocation for each row.
    bytes += entry.row_json.length * 3;
    if (rows.length >= limit || (rows.length > 0 && bytes > SNAPSHOT_BYTE_BUDGET)) {
      more = true;
      break;
    }
    const row = JSON.parse(entry.row_json) as SyncPayload;
    rows.push({ table: entry.table_name, id: row.id as string | number, row });
    position = entry.position;
  }
  return {
    epoch,
    seq: anchor.seq,
    rows,
    isEmpty: Boolean(anchor.empty),
    nextCursor: more ? `${anchor.id}.${position}` : null,
  };
}

type UploadSession = {
  member_id: string;
  epoch: number;
  action: string;
  next_page: number;
  result_json: string | null;
};

function stageRows(sql: SqlStorage, upload: SyncSnapshotUpload): void {
  const schemas = new Map<string, string[]>();
  for (const { table, id, row } of upload.rows) {
    if (!isSyncTable(table) || !isObject(row) || row.id !== id) throw new InvalidSyncData();
    if (table === 'Settings' ? id !== 1 : typeof id !== 'string' || id.length === 0) {
      throw new InvalidSyncData();
    }
    let columns = schemas.get(table);
    if (!columns) {
      columns = tableColumns(sql, table);
      schemas.set(table, columns);
    }
    if (
      Object.keys(row).length !== columns.length ||
      columns.some((name) => {
        const value = row[name];
        return (
          value !== null &&
          typeof value !== 'string' &&
          typeof value !== 'boolean' &&
          (typeof value !== 'number' || !Number.isFinite(value))
        );
      })
    )
      throw new InvalidSyncData();
    if (
      !sql.exec(
        'INSERT OR IGNORE INTO sync_upload_rows VALUES (?, ?, ?, ?)',
        upload.uploadId,
        table,
        String(id),
        JSON.stringify(row),
      ).rowsWritten
    )
      throw new InvalidSyncData();
  }
}

export function completedReset(
  sql: SqlStorage,
  memberId: string,
  oldEpoch: number,
  upload: SyncSnapshotUpload,
  fingerprint: string,
): SyncSnapshotUploadResult | undefined {
  if (!upload.finalize) return undefined;
  const saved = sql
    .exec<{ result_json: string }>(
      `SELECT result_json FROM sync_uploads AS upload JOIN sync_upload_pages AS page
       ON page.upload_id = upload.id AND page.page = upload.next_page - 1
     WHERE upload.id = ? AND upload.member_id = ? AND upload.epoch = ?
       AND upload.action = 'reset' AND upload.result_json IS NOT NULL AND page.page = ?
       AND page.fingerprint = ? AND upload.expires_at > ?`,
      upload.uploadId,
      memberId,
      oldEpoch,
      upload.page,
      fingerprint,
      Date.now(),
    )
    .toArray()[0];
  return saved ? (JSON.parse(saved.result_json) as SyncSnapshotUploadResult) : undefined;
}

function replaceLedger(sql: SqlStorage, uploadId: string): void {
  for (const table of [...SYNC_SNAPSHOT_TABLES].reverse()) sql.exec(`DELETE FROM ${quote(table)}`);
  for (const table of SYNC_SNAPSHOT_TABLES) {
    const columns = tableColumns(sql, table);
    sql.exec(
      `INSERT INTO ${quote(table)} (${columns.map(quote).join(', ')})
       SELECT ${columns.map((name) => `json_extract(row_json, '$.${name}')`).join(', ')}
       FROM sync_upload_rows WHERE upload_id = ? AND table_name = ?`,
      uploadId,
      table,
    );
  }
  // Older local databases create the default settings lazily, the first time settings is opened.
  sql.exec(
    'INSERT INTO Settings (id, updatedAt) VALUES (1, CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING',
  );
  const invalidImages = sql
    .exec(
      `SELECT 1 FROM UploadAsset AS asset
    WHERE asset.deletedAt IS NULL AND NOT EXISTS (
      SELECT 1 FROM image_objects WHERE asset_sha256 = asset.sha256 AND variant = 'main'
    ) OR (asset.deletedAt IS NULL AND asset.thumbnailPath IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM image_objects WHERE asset_sha256 = asset.sha256 AND variant = 'thumb'
    )) LIMIT 1`,
    )
    .toArray();
  if (invalidImages.length) throw new InvalidSyncData();
}

export function acceptSnapshotPage(
  sql: SqlStorage,
  memberId: string,
  epoch: number,
  action: 'init' | 'reset',
  upload: SyncSnapshotUpload,
  fingerprint: string,
): { result: SyncSnapshotUploadResult; changed: boolean } {
  const now = Date.now();
  sql.exec('DELETE FROM sync_uploads WHERE expires_at <= ?', now);
  const { uploadId, page, finalize } = upload;
  const session = sql
    .exec<UploadSession>(
      'SELECT member_id, epoch, action, next_page, result_json FROM sync_uploads WHERE id = ?',
      uploadId,
    )
    .toArray()[0];
  if (
    session &&
    (session.member_id !== memberId || session.epoch !== epoch || session.action !== action)
  ) {
    throw new SyncStateConflict();
  }
  if (session && page < session.next_page) {
    const saved = sql
      .exec<{ fingerprint: string }>(
        'SELECT fingerprint FROM sync_upload_pages WHERE upload_id = ? AND page = ?',
        uploadId,
        page,
      )
      .one();
    if (saved.fingerprint !== fingerprint) throw new SyncStateConflict();
    const result =
      session.result_json && page === session.next_page - 1
        ? (JSON.parse(session.result_json) as SyncSnapshotUploadResult)
        : { epoch, seq: 0, complete: false };
    return { result, changed: false };
  }
  if (session?.result_json || page !== (session?.next_page ?? 0)) throw new SyncStateConflict();
  if (
    action === 'init' &&
    (!isEmptyLedger(sql) ||
      currentSeq(sql, epoch) !== 0 ||
      sql
        .exec(
          "SELECT 1 FROM sync_uploads WHERE action = 'init' AND epoch = ? AND result_json IS NOT NULL LIMIT 1",
          epoch,
        )
        .toArray().length)
  ) {
    throw new SyncStateConflict();
  }
  if (!session) {
    sql.exec(
      'INSERT INTO sync_uploads VALUES (?, ?, ?, ?, 0, ?, NULL)',
      uploadId,
      memberId,
      epoch,
      action,
      now + SESSION_TTL_MS,
    );
  }
  stageRows(sql, upload);
  sql.exec('INSERT INTO sync_upload_pages VALUES (?, ?, ?)', uploadId, page, fingerprint);
  sql.exec(
    'UPDATE sync_uploads SET next_page = ?, expires_at = ? WHERE id = ?',
    page + 1,
    now + SESSION_TTL_MS,
    uploadId,
  );
  if (!finalize) return { result: { epoch, seq: 0, complete: false }, changed: false };

  replaceLedger(sql, uploadId);
  clearReplayHistory(sql);
  let seq = 0;
  if (action === 'init') {
    // Members that joined before initialization can catch up from their default-only snapshot.
    if (
      !sql.exec('SELECT 1 FROM ShoppingList WHERE id = ?', SHOPPING_DEFAULT_LIST_ID).toArray()
        .length
    ) {
      writeJournal(
        sql,
        epoch,
        ++seq,
        memberId,
        uploadId,
        'ShoppingList',
        SHOPPING_DEFAULT_LIST_ID,
        'delete',
        1,
        [{ table: 'ShoppingList', id: SHOPPING_DEFAULT_LIST_ID, row: null }],
      );
    }
    for (const table of SYNC_SNAPSHOT_TABLES) {
      for (const { row_json } of sql.exec<{ row_json: string }>(
        'SELECT row_json FROM sync_upload_rows WHERE upload_id = ? AND table_name = ? ORDER BY row_id',
        uploadId,
        table,
      )) {
        const row = JSON.parse(row_json) as SyncPayload;
        const id = row.id as string | number;
        writeJournal(
          sql,
          epoch,
          ++seq,
          memberId,
          uploadId,
          table,
          String(id),
          'upsert',
          typeof row.version === 'number' ? row.version : 1,
          [{ table, id, row }],
        );
      }
    }
  } else {
    sql.exec(
      'UPDATE household_meta SET epoch = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
      epoch + 1,
    );
    sql.exec('DELETE FROM sync_journal_rows');
    sql.exec('DELETE FROM sync_log');
    sql.exec('DELETE FROM processed_ops');
    sql.exec('DELETE FROM executed_operations');
  }
  const nextEpoch = action === 'reset' ? epoch + 1 : epoch;
  sql.exec('DELETE FROM sync_snapshots');
  sql.exec('DELETE FROM sync_uploads WHERE id <> ?', uploadId);
  sql.exec('DELETE FROM sync_upload_rows WHERE upload_id = ?', uploadId);
  sql.exec(`DELETE FROM image_objects WHERE NOT EXISTS (
    SELECT 1 FROM UploadAsset WHERE deletedAt IS NULL AND sha256 = image_objects.asset_sha256
      AND (image_objects.variant = 'main' OR thumbnailPath IS NOT NULL)
  )`);
  sql.exec('UPDATE image_objects SET epoch = ?', nextEpoch);
  const result = { epoch: nextEpoch, seq, complete: true };
  sql.exec(
    'UPDATE sync_uploads SET result_json = ? WHERE id = ?',
    JSON.stringify(result),
    uploadId,
  );
  return { result, changed: true };
}
