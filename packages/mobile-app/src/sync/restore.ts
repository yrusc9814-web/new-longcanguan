import type { SyncRowChange, SyncSnapshotUploadResult } from '@dafan/shared/sync';

import type { DatabaseClient } from '../db/database.js';
import { BUSINESS_TABLES } from '../db/schema.js';
import { LocalApiError } from '../local-api/protocol.js';
import {
  commitBackupRestore,
  validateBackup,
  type BackupConsumers,
} from '../modules/backup/service.js';
import { sha256Hex } from '../modules/uploads/codec.js';
import type { UploadsFilesBridge } from '../native/upload-files.js';
import { SyncHttpError, type SyncHttpClient } from './http.js';
import { createImageSyncQueue } from './images.js';
import { writeSyncState } from './ledger.js';

interface OwnerRestoreOptions {
  readonly database: DatabaseClient;
  readonly http: SyncHttpClient;
  readonly files: UploadsFilesBridge;
  /** 备份模块的消费者集合（`consumeHighRiskToken` + `lockPin`）。 */
  readonly consumers?: BackupConsumers;
  /** 也可只传扁平的一次性令牌消费者（引擎/测试接线更简洁）。 */
  readonly consumeHighRiskToken?: (token: string | null) => void | Promise<void>;
  readonly request: Request;
  readonly pageSize?: number;
  /** 兼容既有接线：引擎传入的共享图片队列（恢复时使用备份暂存区上传）。 */
  readonly images?: unknown;
}

/**
 * 馆主两阶段云端恢复。
 *
 * 顺序不可调换：一次性令牌 → 只读校验 ZIP → 图片补到 R2 → 分页 `epoch-reset`
 * （服务端推进 epoch 并广播）→ 本地同一事务替换 27 表 + 写新 `(epoch, S)` + 清发件箱。
 */
export async function restoreOwnerCloudBackup(options: OwnerRestoreOptions) {
  const consume = options.consumers?.consumeHighRiskToken ?? options.consumeHighRiskToken;
  if (!consume) throw new LocalApiError(401, 'HIGH_RISK_AUTHORIZATION_REQUIRED', '缺少高风险授权');
  await consume(options.request.headers.get('X-High-Risk-Token'));

  const { staged, ordered } = await validateBackup(options.database, options.request);

  // 备份 ZIP 是图片的唯一事实来源：用一个只读文件桥把它们按原协议上传到 R2。
  const images = createImageSyncQueue({
    http: options.http,
    files: {
      async statFile({ path }) {
        const data = staged.uploadFiles_.get(path);
        if (!data) return { exists: false, size: 0, sha256: '' };
        return { exists: true, size: data.length, sha256: await sha256Hex(data) };
      },
      async readFile({ path }) {
        return { data: staged.uploadFiles_.get(path) ?? null };
      },
      async writeFile() {
        throw new Error('备份图片暂存区只读');
      },
    },
  });
  for (const row of staged.tables.UploadAsset) {
    if (row.deletedAt) continue;
    if (
      typeof row.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(row.sha256) ||
      typeof row.storagePath !== 'string'
    ) {
      throw new LocalApiError(422, 'INVALID_FILE', '备份图片缺少有效的路径或哈希');
    }
    images.enqueueUpload({
      sha256: row.sha256,
      storagePath: row.storagePath,
      thumbnailPath: typeof row.thumbnailPath === 'string' ? row.thumbnailPath : null,
    });
  }
  while (images.pending > 0) {
    if ((await images.drain()).failed > 0) {
      throw new LocalApiError(502, 'IMAGE_UPLOAD_FAILED', '部分备份图片未能上传到云端');
    }
  }

  const pageSize = options.pageSize ?? 500;
  const uploadId = crypto.randomUUID();
  const rows = BUSINESS_TABLES.flatMap((table) =>
    staged.tables[table].map((row) => {
      if (typeof row.id !== 'string' && typeof row.id !== 'number') {
        throw new LocalApiError(422, 'INVALID_FILE', `备份表 ${table} 缺少有效主键`);
      }
      return { table, id: row.id, row } as SyncRowChange;
    }),
  );

  let result: SyncSnapshotUploadResult | null = null;
  // 空库也必须走一次 finalize（允许空页），否则服务端不会推进代际。
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  for (let page = 0; page < pages; page += 1) {
    const start = page * pageSize;
    const finalize = page === pages - 1;
    const raw = (await options.http.request('/api/sync/epoch-reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        uploadId,
        page,
        rows: rows.slice(start, start + pageSize),
        finalize,
      }),
    })) as SyncSnapshotUploadResult;
    const epoch = Number(raw?.epoch);
    const seq = Number(raw?.seq);
    if (!Number.isSafeInteger(epoch) || !Number.isSafeInteger(seq) || raw?.complete !== finalize) {
      throw new SyncHttpError(502, 'BAD_RESPONSE', '云端恢复响应无效');
    }
    result = { epoch, seq, complete: true };
  }
  if (!result) throw new SyncHttpError(502, 'BAD_RESPONSE', '云端恢复未返回结果');
  const { epoch, seq } = result;

  await commitBackupRestore(
    options.database,
    options.files,
    staged,
    ordered,
    { lockPin: options.consumers?.lockPin ?? (async () => undefined) },
    (tx) => writeSyncState(tx, epoch, seq),
  );
  return { epoch, seq, tables: BUSINESS_TABLES.length, images: staged.uploadFiles_.size };
}
