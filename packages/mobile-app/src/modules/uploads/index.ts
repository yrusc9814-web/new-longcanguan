import type { DatabaseClient } from '../../db/database.js';
import { dataResult, readFormDataBody } from '../../local-api/protocol.js';
import type { LocalApiRouter } from '../../local-api/router.js';
import { uploadImage, type UploadServiceOptions } from './service.js';

/**
 * 上传域路由（保留端点 1 条）：
 * `POST /api/v1/uploads/images` — EXIF 正置 → WebP 压缩 → SHA-256 →
 * `FilesDir/uploads/` 原子落盘 → `UploadAsset` + 发件箱同事务登记。
 */
export function registerUploads(
  router: LocalApiRouter,
  getDatabase: () => Promise<DatabaseClient>,
  files?: { uploadServiceOptions?: UploadServiceOptions },
): void {
  router.register('POST', '/api/v1/uploads/images', async ({ request }) => {
    const form = await readFormDataBody(request);
    const database = await getDatabase();
    const asset = await uploadImage(database, form, {
      now: router.options.now,
      ...files?.uploadServiceOptions,
    });
    return dataResult(asset, { status: 201 });
  });
}

export * from './codec.js';
export * from './service.js';
