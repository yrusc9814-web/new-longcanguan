/**
 * 旧 epoch 待同步数据的本地安全备份 ZIP（`EPOCH_RESET` / 强制换绑前）。
 *
 * 目的：馆主整库恢复（epoch + 1）后，其他成员的旧 epoch 发件箱与业务行会失去锚点；
 * 直接丢弃会让用户离线工作永久消失。因此先导出一份自包含 ZIP：
 *   manifest.json + db/<27 表>.json（含全部业务行，软删行保留）+ sync/pending.json
 *   （待同步操作快照，含 opId/baseVersion/kind/commandType/payload）
 * 复用手背备份的 `fflate` 与哈希算法，并沿用同一套路径/表名校验。
 */
import { zipSync, type Zippable } from 'fflate';

import { BUSINESS_TABLES, SYNC_OUTBOX_TABLE } from '../db/schema.js';
import type { DatabaseClient } from '../db/database.js';
import { sha256Hex } from '../modules/uploads/codec.js';

export const SAFETY_BACKUP_VERSION = 1;

interface ManifestEntry {
  readonly size: number;
  readonly sha256: string;
}

export interface SafetyBackupManifest {
  readonly formatVersion: number;
  readonly kind: 'epoch-safety';
  readonly createdAt: string;
  readonly fromEpoch: number;
  readonly toEpoch: number;
  readonly tables: readonly string[];
  readonly files: Record<string, ManifestEntry>;
}

export interface SafetyBackup {
  readonly name: string;
  readonly blob: Blob;
  readonly bytes: Uint8Array;
  readonly manifest: SafetyBackupManifest;
}

export interface SafetyBackupOptions {
  readonly database: DatabaseClient;
  readonly fromEpoch: number;
  readonly toEpoch: number;
  readonly now?: () => Date;
}

function entryName(table: string): string {
  return `db/${table}.json`;
}

export async function createSafetyBackup(options: SafetyBackupOptions): Promise<SafetyBackup> {
  const { database } = options;
  const files: Record<string, ManifestEntry> = {};
  const zipEntries: Zippable = {};

  for (const table of BUSINESS_TABLES) {
    const rows = await database.query<Record<string, unknown>>(
      `SELECT * FROM "${table}" ORDER BY rowid`,
    );
    const bytes = new TextEncoder().encode(JSON.stringify(rows));
    zipEntries[entryName(table)] = bytes;
    files[entryName(table)] = { size: bytes.byteLength, sha256: await sha256Hex(bytes) };
  }

  const pending = await database.query<Record<string, unknown>>(
    `SELECT "opId","entity","entityId","kind","commandType","baseVersion","payloadJson","epoch","createdAt"
       FROM "${SYNC_OUTBOX_TABLE}" ORDER BY rowid`,
  );
  const pendingBytes = new TextEncoder().encode(JSON.stringify(pending));
  zipEntries['sync/pending.json'] = pendingBytes;
  files['sync/pending.json'] = {
    size: pendingBytes.byteLength,
    sha256: await sha256Hex(pendingBytes),
  };

  const createdAt = (options.now ?? (() => new Date()))().toISOString();
  const manifest: SafetyBackupManifest = {
    formatVersion: SAFETY_BACKUP_VERSION,
    kind: 'epoch-safety',
    createdAt,
    fromEpoch: options.fromEpoch,
    toEpoch: options.toEpoch,
    tables: [...BUSINESS_TABLES],
    files,
  };
  zipEntries['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));

  const bytes = zipSync(zipEntries, { level: 6 });
  const stamp = createdAt.replace(/[:.]/g, '-');
  return {
    name: `dafan-epoch-${options.fromEpoch}-to-${options.toEpoch}-${stamp}.zip`,
    blob: new Blob([bytes as unknown as BlobPart], { type: 'application/zip' }),
    bytes,
    manifest,
  };
}

export interface SafetyBackupStore {
  /** 持久化到本机文件；返回可读路径。 */
  write(backup: SafetyBackup): Promise<string>;
}

export interface SafetyBackupFiles {
  writeFile(options: { path: string; data: Uint8Array }): Promise<void>;
}

/** 默认写到 uploads 同源的 `safety-backups/` 子目录，受原生路径策略保护。 */
export function createSafetyBackupStore(files: SafetyBackupFiles): SafetyBackupStore {
  return {
    async write(backup) {
      const path = `safety-backups/${backup.name.replace(/[^A-Za-z0-9._-]/g, '_')}`;
      await files.writeFile({ path, data: backup.bytes });
      return path;
    },
  };
}
