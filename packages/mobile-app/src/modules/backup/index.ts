import type { DatabaseClient } from '../../db/database.js';
import { blobResult, dataResult } from '../../local-api/protocol.js';
import type { LocalApiRouter } from '../../local-api/router.js';
import type { UploadsFilesBridge } from '../../native/upload-files.js';
import type { BackupConsumers } from './service.js';
import { backupDownloadName, exportBackup, restoreBackup } from './service.js';

export interface BackupModuleOptions {
  readonly consumers: BackupConsumers;
  /** 文件桥注入；缺省用模块单例（Android 真机插件 / 桌面后备）。 */
  readonly files?: UploadsFilesBridge;
}

/**
 * 备份域路由（保留端点 2 条）：
 * - `GET /api/v1/backups/export`：脱敏业务快照 + 引用上传文件 → ZIP（fflate）。
 * - `POST /api/v1/backups/restore`：一次性高风险令牌 + 隔离校验 + 单事务恢复。
 */
export function registerBackups(
  router: LocalApiRouter,
  getDatabase: () => Promise<DatabaseClient>,
  files: BackupModuleOptions,
): void {
  router.register('GET', '/api/v1/backups/export', async () => {
    const database = await getDatabase();
    const { blob } = await exportBackup(database, { now: router.options.now, files: files.files });
    return blobResult(blob, {
      headers: {
        'content-disposition': `attachment; filename="${backupDownloadName(router.options.now?.() ?? new Date())}"`,
      },
    });
  });

  router.register('POST', '/api/v1/backups/restore', async ({ request }) => {
    const database = await getDatabase();
    const result = await restoreBackup(database, request, files.consumers, { files: files.files });
    return dataResult(
      { restoredTables: result.restoredTables, restoredFiles: result.restoredFiles },
      { status: 200 },
    );
  });
}

export * from './service.js';
