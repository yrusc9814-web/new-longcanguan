/** 脱敏备份导出，以及通过 SQLite 提交标记协调的目录恢复。 */
import { unzipSync, zipSync, type Zippable } from 'fflate';

import type { DatabaseClient, WriteTransaction } from '../../db/database.js';
import { BUSINESS_TABLES } from '../../db/schema.js';
import type { SqlValue } from '../../db/types.js';
import { AsyncMutex } from '../../db/mutex.js';
import { LocalApiError, readFormDataBody } from '../../local-api/protocol.js';
import { uploadFiles as defaultFiles, type UploadsFilesBridge } from '../../native/upload-files.js';
import { localDate } from '../common.js';
import { sha256Hex } from '../uploads/codec.js';

const restoreQueue = new AsyncMutex();

async function committedRestoreId(database: Pick<WriteTransaction, 'query'>): Promise<number> {
  const [row] = await database.query<{ application_id: number }>('PRAGMA application_id');
  return row?.application_id ?? 0;
}

export function recoverBackupFiles(database: DatabaseClient, files = defaultFiles): Promise<void> {
  return restoreQueue.run(async () => {
    await files.recoverRestore({ restoreId: await committedRestoreId(database) });
  });
}

const MANIFEST_NAME = 'manifest.json';
const DB_ENTRY_PREFIX = 'db/';
const UPLOADS_ENTRY_PREFIX = 'uploads/';

export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_SCHEMA_VERSION = 2;

interface ManifestEntry {
  readonly size: number;
  readonly sha256: string;
}

export interface BackupManifest {
  readonly formatVersion: number;
  readonly schemaVersion: number;
  readonly createdAt: string;
  readonly tables: readonly string[];
  readonly files: Record<string, ManifestEntry>;
}

const FORBIDDEN_TABLES = ['device_local_config', 'sync_outbox', 'sync_state'] as const;
const FORBIDDEN_MANIFEST_FIELDS = [
  'pinHash',
  'memberToken',
  'cloudOrigin',
  'householdId',
  'memberId',
] as const;

export interface BackupConsumers {
  /**
   * 一次性高风险令牌消费：`restore` 强制要求有效的 `X-High-Risk-Token`；
   * 消费成功后立即作废。抛错或返回 false = 401 HIGH_RISK_AUTHORIZATION_REQUIRED。
   */
  readonly consumeHighRiskToken: (token: string | null) => void | Promise<void>;
  /** 恢复完成后锁定 PIN 会话，触发用户重新解锁（与原生门禁联动由调用方同步 JS 处理）。 */
  readonly lockPin: () => Promise<void>;
}

export interface ExportResult {
  readonly blob: Blob;
  readonly manifest: BackupManifest;
}

function entryName(table: string): string {
  return `${DB_ENTRY_PREFIX}${table}.json`;
}

function assertSafeUploadEntry(name: string): string {
  const relative = name.slice(UPLOADS_ENTRY_PREFIX.length);
  if (
    relative.length === 0 ||
    relative.includes('\\') ||
    relative.includes('..') ||
    relative.startsWith('/') ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(relative)
  ) {
    throw new LocalApiError(422, 'INVALID_FILE', `备份包含非法上传路径：${name}`);
  }
  return relative;
}

interface UploadReferenceRow {
  readonly storagePath: string;
  readonly thumbnailPath: string | null;
}

function uploadReferences(snapshot: Record<string, readonly Record<string, unknown>[]>): string[] {
  const filenames = new Set<string>();
  const add = (path: unknown, relative = false) => {
    if (typeof path !== 'string' || !path) return;
    if (path.startsWith(UPLOADS_ENTRY_PREFIX) || path.startsWith('/uploads/')) {
      filenames.add(path.replace(/^\/?uploads\//, ''));
    } else if (relative) {
      filenames.add(path);
    }
  };
  for (const [table, rows] of Object.entries(snapshot)) {
    for (const row of rows) {
      if (row.deletedAt) continue;
      if (table === 'UploadAsset') {
        const asset = row as unknown as UploadReferenceRow;
        add(asset.storagePath, true);
        add(asset.thumbnailPath, true);
      }
      add(row.imagePath);
      add(row.avatarPath);
      if (table === 'MealRecord' && typeof row.photosJson === 'string') {
        const photos: unknown = JSON.parse(row.photosJson);
        if (Array.isArray(photos)) for (const photo of photos) add(photo);
      }
    }
  }
  return [...filenames].sort();
}

/** 27 张业务表快照（脱敏：只含业务表，绝不包含端侧私有表）。 */
async function snapshotBusinessTables(
  database: Pick<WriteTransaction, 'query'>,
): Promise<Record<string, readonly Record<string, unknown>[]>> {
  const snapshot: Record<string, readonly Record<string, unknown>[]> = {};
  for (const table of BUSINESS_TABLES) {
    snapshot[table] = await database.query<Record<string, unknown>>(
      `SELECT * FROM "${table}" ORDER BY rowid`,
    );
  }
  return snapshot;
}

export async function exportBackup(
  database: DatabaseClient,
  options: { readonly now?: () => Date; readonly files?: UploadsFilesBridge } = {},
): Promise<ExportResult> {
  return restoreQueue.run(() => database.withWriteTransaction((tx) => buildBackup(tx, options)));
}

async function buildBackup(
  tx: WriteTransaction,
  options: { readonly now?: () => Date; readonly files?: UploadsFilesBridge },
): Promise<ExportResult> {
  const filesBridge = options.files ?? defaultFiles;
  const snapshot = await snapshotBusinessTables(tx);
  const uploadFilenames = uploadReferences(snapshot);

  const files: Record<string, ManifestEntry> = {};
  const zipEntries: Zippable = {};

  const tablePayload: Record<string, Uint8Array> = {};
  for (const table of BUSINESS_TABLES) {
    const bytes = new TextEncoder().encode(JSON.stringify(snapshot[table]));
    tablePayload[entryName(table)] = bytes;
    files[entryName(table)] = { size: bytes.byteLength, sha256: await sha256Hex(bytes) };
  }

  // 被引用的上传文件必须全部存在且哈希一致：缺失或篡改 → 409 阻止残缺导出。
  for (const filename of uploadFilenames) {
    const stat = await filesBridge.statFile({ path: filename });
    if (!stat.exists) {
      throw new LocalApiError(
        409,
        'UPLOAD_FILE_MISSING',
        `备份引用的上传文件缺失：/uploads/${filename}`,
        { details: { filename } },
      );
    }
    const data = await filesBridge.readFile({ path: filename });
    if (!data.data) {
      throw new LocalApiError(409, 'UPLOAD_FILE_MISSING', `备份引用的上传文件不可读：${filename}`);
    }
    const actual = await sha256Hex(data.data);
    if (actual !== stat.sha256) {
      throw new LocalApiError(409, 'UPLOAD_FILE_CORRUPT', `上传文件哈希不一致：${filename}`);
    }
    const name = `${UPLOADS_ENTRY_PREFIX}${filename}`;
    files[name] = { size: data.data.byteLength, sha256: stat.sha256 };
    zipEntries[name] = data.data;
  }

  const manifest: BackupManifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    tables: [...BUSINESS_TABLES],
    files,
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  zipEntries[MANIFEST_NAME] = manifestBytes;
  for (const [name, bytes] of Object.entries(tablePayload)) {
    zipEntries[name] = bytes;
  }

  const zipped = zipSync(zipEntries, { level: 6 });
  const blob = new Blob([zipped as unknown as BlobPart], { type: 'application/zip' });
  return { blob, manifest };
}

interface StagedRestore {
  readonly manifest: BackupManifest;
  readonly tables: Record<string, readonly Record<string, unknown>[]>;
  readonly uploadFiles_: ReadonlyMap<string, Uint8Array>;
  readonly pendingHashes: ReadonlyArray<{ name: string; bytes: Uint8Array; expected: string }>;
}

/**
 * 隔离校验阶段：ZIP 解包、manifest 哈希逐条核验、表集合与列结构核验。
 * 不触碰数据库与 uploads 目录；失败即整体拒绝。
 */
export function stageRestoreSync(zipBytes: Uint8Array): StagedRestore {
  let unpacked: Record<string, Uint8Array>;
  try {
    unpacked = unzipSync(zipBytes);
  } catch {
    throw new LocalApiError(422, 'INVALID_FILE', '备份文件不是有效的 ZIP');
  }
  const manifestBytes = unpacked[MANIFEST_NAME];
  if (!manifestBytes) {
    throw new LocalApiError(422, 'INVALID_FILE', '备份缺少 manifest.json');
  }
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as BackupManifest;
  } catch {
    throw new LocalApiError(422, 'INVALID_FILE', 'manifest.json 不是合法 JSON');
  }
  if (
    !manifest ||
    !Array.isArray(manifest.tables) ||
    !manifest.files ||
    typeof manifest.files !== 'object' ||
    Array.isArray(manifest.files)
  ) {
    throw new LocalApiError(422, 'INVALID_FILE', 'manifest 结构无效');
  }
  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new LocalApiError(422, 'INVALID_FILE', `不支持的备份格式版本：${manifest.formatVersion}`);
  }
  if (manifest.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw new LocalApiError(422, 'INVALID_FILE', `备份库结构版本不符：${manifest.schemaVersion}`);
  }

  // 脱敏硬校验：任何端侧私有表或已知私密字段字节都不允许出现在备份里。
  for (const forbidden of FORBIDDEN_TABLES) {
    if (unpacked[`${DB_ENTRY_PREFIX}${forbidden}.json`] !== undefined) {
      throw new LocalApiError(422, 'INVALID_FILE', `备份包含禁止的端侧表：${forbidden}`);
    }
  }
  const rawManifestText = new TextDecoder().decode(manifestBytes);
  for (const secret of FORBIDDEN_MANIFEST_FIELDS) {
    if (rawManifestText.includes(`"${secret}"`)) {
      throw new LocalApiError(422, 'INVALID_FILE', `manifest 携带私密字段：${secret}`);
    }
  }

  const archiveNames = Object.keys(unpacked);
  if (
    archiveNames.length !== Object.keys(manifest.files).length + 1 ||
    archiveNames.some((name) => name !== MANIFEST_NAME && !Object.hasOwn(manifest.files, name))
  ) {
    throw new LocalApiError(422, 'INVALID_FILE', 'manifest 与 ZIP 内容不一致');
  }
  const declaredTables = new Set(manifest.tables);
  if (
    declaredTables.size !== BUSINESS_TABLES.length ||
    manifest.tables.length !== declaredTables.size
  ) {
    throw new LocalApiError(422, 'INVALID_FILE', '备份表集合与端侧 schema 不一致');
  }
  for (const table of BUSINESS_TABLES) {
    if (!declaredTables.has(table)) {
      throw new LocalApiError(422, 'INVALID_FILE', `备份缺少业务表：${table}`);
    }
  }

  const tables: Record<string, readonly Record<string, unknown>[]> = {};
  const uploads = new Map<string, Uint8Array>();
  const pendingHashes: Array<{ name: string; bytes: Uint8Array; expected: string }> = [];
  for (const [name, entry] of Object.entries(manifest.files)) {
    const bytes = unpacked[name];
    if (
      !entry ||
      !Number.isSafeInteger(entry.size) ||
      typeof entry.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(entry.sha256)
    ) {
      throw new LocalApiError(422, 'INVALID_FILE', `条目描述无效：${name}`);
    }
    if (!bytes) {
      throw new LocalApiError(422, 'INVALID_FILE', `备份缺少条目：${name}`);
    }
    if (bytes.byteLength !== entry.size) {
      throw new LocalApiError(422, 'INVALID_FILE', `条目大小不一致：${name}`);
    }
    pendingHashes.push({ name, bytes, expected: entry.sha256 });
    if (name.startsWith(DB_ENTRY_PREFIX)) {
      const table = name.slice(DB_ENTRY_PREFIX.length, -'.json'.length);
      if (!declaredTables.has(table) || name !== entryName(table)) {
        throw new LocalApiError(422, 'INVALID_FILE', `备份包含未声明的表：${table}`);
      }
      let rows: unknown;
      try {
        rows = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new LocalApiError(422, 'INVALID_FILE', `表数据不是合法 JSON：${table}`);
      }
      if (!Array.isArray(rows)) {
        throw new LocalApiError(422, 'INVALID_FILE', `表数据必须是行数组：${table}`);
      }
      tables[table] = rows as Record<string, unknown>[];
    } else if (name.startsWith(UPLOADS_ENTRY_PREFIX)) {
      uploads.set(assertSafeUploadEntry(name), bytes);
    } else {
      throw new LocalApiError(422, 'INVALID_FILE', `备份包含未知条目：${name}`);
    }
  }

  for (const table of BUSINESS_TABLES) {
    if (tables[table] === undefined) {
      throw new LocalApiError(422, 'INVALID_FILE', `备份缺少业务表数据：${table}`);
    }
  }
  return { manifest, tables, uploadFiles_: uploads, pendingHashes };
}

/** stage 之后的异步哈希核验：任一 sha256 不匹配即整体拒绝。 */
export async function verifyStagedHashes(staged: StagedRestore): Promise<void> {
  for (const item of staged.pendingHashes) {
    const actual = await sha256Hex(item.bytes);
    if (actual !== item.expected) {
      throw new LocalApiError(422, 'INVALID_FILE', `条目哈希不一致：${item.name}`);
    }
  }
  // manifest 自身也必须与其声明的 files 哈希集合自洽（防篡改表数据后重打包）。
  const declared = Object.keys(staged.manifest.files).sort().join('|');
  const present = [
    ...staged.manifest.tables.map(entryName),
    ...[...staged.uploadFiles_.keys()].map((filename) => `${UPLOADS_ENTRY_PREFIX}${filename}`),
  ]
    .sort()
    .join('|');
  if (declared !== present) {
    throw new LocalApiError(422, 'INVALID_FILE', 'manifest 与 ZIP 内容不一致');
  }
}

/** 核对列结构，并计算父表先于子表的恢复顺序。 */
async function verifyStagedSchema(
  database: Pick<WriteTransaction, 'query'>,
  staged: StagedRestore,
): Promise<string[]> {
  const dependencies = new Map<string, Set<string>>();
  for (const table of BUSINESS_TABLES) {
    const columns = await database.query<{ name: string }>(`PRAGMA table_info("${table}")`);
    const localColumns = new Set(columns.map((column) => column.name));
    if (localColumns.size === 0) {
      throw new LocalApiError(500, 'INTERNAL_ERROR', `端侧表缺失：${table}`);
    }
    for (const row of staged.tables[table]) {
      if (
        !row ||
        typeof row !== 'object' ||
        Array.isArray(row) ||
        Object.keys(row).length === 0 ||
        Object.entries(row).some(
          ([key, value]) =>
            !localColumns.has(key) ||
            (value !== null &&
              typeof value !== 'string' &&
              typeof value !== 'boolean' &&
              !(typeof value === 'number' && Number.isFinite(value))),
        )
      ) {
        throw new LocalApiError(422, 'INVALID_FILE', `表 ${table} 的行结构无效`);
      }
    }
    const foreignKeys = await database.query<{ table: string }>(
      `PRAGMA foreign_key_list("${table}")`,
    );
    dependencies.set(table, new Set(foreignKeys.map((key) => key.table)));
  }

  const ordered: string[] = [];
  while (dependencies.size > 0) {
    const ready = [...dependencies].filter(([, parents]) =>
      [...parents].every((parent) => ordered.includes(parent)),
    );
    if (ready.length === 0)
      throw new LocalApiError(500, 'INTERNAL_ERROR', '业务表外键顺序不可解析');
    for (const [table] of ready) {
      ordered.push(table);
      dependencies.delete(table);
    }
  }
  return ordered;
}

async function replaceBusinessTables(
  tx: WriteTransaction,
  staged: StagedRestore,
  ordered: readonly string[],
): Promise<void> {
  await tx.exec('PRAGMA defer_foreign_keys = ON');
  for (const table of [...ordered].reverse()) {
    await tx.run(`DELETE FROM "${table}"`);
  }
  for (const table of ordered) {
    for (const row of staged.tables[table]) {
      const columns = Object.keys(row);
      try {
        await tx.run(
          `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
           VALUES (${columns.map(() => '?').join(', ')})`,
          columns.map((column) => row[column] as SqlValue),
        );
      } catch (error) {
        if (/constraint|not null|unique/i.test(String(error))) {
          throw new LocalApiError(422, 'INVALID_FILE', `表 ${table} 的行违反数据库约束`);
        }
        throw error;
      }
    }
  }
  const violations = await tx.query<{ rowid: number; table: string }>('PRAGMA foreign_key_check');
  if (violations.length > 0) {
    throw new LocalApiError(
      422,
      'INVALID_FILE',
      `备份数据外键校验失败：${violations[0]?.table ?? 'unknown'}`,
    );
  }
}

export interface RestoreResult {
  readonly restoredTables: number;
  readonly restoredFiles: number;
  readonly replacedUploads: string[];
}

export async function restoreBackup(
  database: DatabaseClient,
  request: Request,
  consumers: BackupConsumers,
  options: { readonly files?: UploadsFilesBridge } = {},
): Promise<RestoreResult> {
  const token = request.headers.get('X-High-Risk-Token');
  await consumers.consumeHighRiskToken(token);

  const { staged, ordered } = await validateBackup(database, request);
  await commitBackupRestore(database, options.files ?? defaultFiles, staged, ordered, consumers);
  return {
    restoredTables: BUSINESS_TABLES.length,
    restoredFiles: staged.uploadFiles_.size,
    replacedUploads: [...staged.uploadFiles_.keys()].sort(),
  };
}

export async function validateBackup(database: DatabaseClient, request: Request) {
  const form = await readFormDataBody(request);
  const file = form.get('file');
  if (!(file instanceof Blob)) {
    throw new LocalApiError(422, 'INVALID_FILE', '缺少 file 备份字段');
  }
  const staged = stageRestoreSync(new Uint8Array(await file.arrayBuffer()));
  await verifyStagedHashes(staged);
  const ordered = await verifyStagedSchema(database, staged);
  const expectedFiles = uploadReferences(staged.tables);
  if (
    expectedFiles.length !== staged.uploadFiles_.size ||
    expectedFiles.some((path) => !staged.uploadFiles_.has(path))
  ) {
    throw new LocalApiError(422, 'INVALID_FILE', '备份图片与业务数据引用不一致');
  }
  return { staged, ordered };
}

export async function commitBackupRestore(
  database: DatabaseClient,
  filesBridge: UploadsFilesBridge,
  staged: StagedRestore,
  ordered: readonly string[],
  consumers: Pick<BackupConsumers, 'lockPin'>,
  onCommit?: (tx: WriteTransaction) => Promise<void>,
): Promise<void> {
  await restoreQueue.run(async () => {
    const previousId = await committedRestoreId(database);
    await filesBridge.recoverRestore({ restoreId: previousId });
    const restoreId = previousId >= 0x7fffffff || previousId < 0 ? 1 : previousId + 1;
    try {
      await filesBridge.prepareRestore();
      for (const [path, data] of staged.uploadFiles_) {
        await filesBridge.writeRestoreFile({ path, data });
      }
      await database.withWriteTransaction(async (tx) => {
        await replaceBusinessTables(tx, staged, ordered);
        await tx.run('DELETE FROM "sync_outbox"');
        await onCommit?.(tx);
        // SQLite rolls this marker back with the business rows if commit fails.
        await tx.exec(`PRAGMA application_id = ${restoreId}`);
        await consumers.lockPin();
        await filesBridge.activateRestore({ restoreId });
      });
    } finally {
      // Re-read the committed ID so recovery also handles an uncertain commit outcome.
      await filesBridge.recoverRestore({ restoreId: await committedRestoreId(database) });
    }
  });
}

/** 导出文件名：`dafan-backup-YYYY-MM-DD.zip`（本地日历日）。 */
export function backupDownloadName(now: Date): string {
  return `dafan-backup-${localDate(now)}.zip`;
}
