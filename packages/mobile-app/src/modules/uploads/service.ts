/**
 * `POST /api/v1/uploads/images` 与 `assertUploadedPhotos`。
 *
 * 落盘协议（与原生 `SecurityRuntime.uploadsDirectory()` = `FilesDir/uploads/` 严格同源）：
 * - 主图 `uploads/main-*.webp`、缩略图 `uploads/thumb-*.webp`，temp+rename 原子写入；
 * - `UploadAsset` 行与 `sync_outbox` upsert 在同一 SQLite 写事务内提交；
 * - 文件先落盘、事务后提交：事务失败时补偿删除已写文件（上传无旧状态可回滚）。
 */
import type { DatabaseClient, WriteTransaction } from '../../db/database.js';
import { LocalApiError } from '../../local-api/protocol.js';
import { uploadFiles as defaultFiles, type UploadsFilesBridge } from '../../native/upload-files.js';
import { newLocalId } from '../recipes/service.js';
import {
  encodeUploadImage,
  extractUploadedFilenames,
  newUploadFilename,
  sha256Hex,
  uploadsUrl,
  type EncodeUploadOptions,
} from './codec.js';

export interface UploadServiceOptions {
  readonly now?: () => Date;
  /** 测试注入；缺省用真实画布编码。 */
  readonly encode?: EncodeUploadOptions;
  /** 文件桥注入；缺省用模块单例（Android 真机插件 / 桌面后备）。 */
  readonly files?: UploadsFilesBridge;
}

export interface UploadAssetRow {
  readonly id: string;
  readonly filename: string;
  readonly storagePath: string;
  readonly thumbnailPath: string | null;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly recipeId: string | null;
  readonly storeId: string | null;
  readonly mealRecordId: string | null;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UploadImageResult {
  readonly id: string;
  readonly url: string;
  readonly thumbnailUrl: string | null;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly createdAt: string;
}

function parseOptionalId(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string')
    throw new LocalApiError(400, 'VALIDATION_ERROR', `${field} 必须是字符串`);
  return value;
}

interface AssetDbRow {
  readonly id: string;
  readonly filename: string;
  readonly storagePath: string;
  readonly thumbnailPath: string | null;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly recipeId: string | null;
  readonly storeId: string | null;
  readonly mealRecordId: string | null;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function toView(row: AssetDbRow): UploadImageResult {
  return {
    id: row.id,
    url: uploadsUrl(row.filename),
    thumbnailUrl: row.thumbnailPath ? uploadsUrl(row.thumbnailPath) : null,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    width: row.width,
    height: row.height,
    createdAt: row.createdAt,
  };
}

/**
 * 校验照片路径引用：`/uploads/*.webp` 且都存在已登记（未删除）的有效 UploadAsset。
 * 返回违规路径列表（含未登记与已软删）；空数组 = 全部有效。
 */
export async function assertUploadedPhotos(
  database: DatabaseClient,
  photos: readonly string[],
): Promise<string[]> {
  const filenames = extractUploadedFilenames(photos);
  if (filenames.length === 0) return [];
  const placeholders = filenames.map(() => '?').join(', ');
  const rows = await database.query<{ filename: string; deletedAt: string | null }>(
    `SELECT "filename", "deletedAt" FROM "UploadAsset"
     WHERE "filename" IN (${placeholders}) AND "deletedAt" IS NULL`,
    filenames,
  );
  const known = new Set(rows.map((row) => row.filename));
  return filenames.filter((filename) => !known.has(filename));
}

async function insertAsset(tx: WriteTransaction, row: AssetDbRow, opId: string): Promise<void> {
  await tx.run(
    `INSERT INTO "UploadAsset"
       ("id", "filename", "storagePath", "thumbnailPath", "mimeType", "sizeBytes", "sha256",
        "width", "height", "recipeId", "storeId", "mealRecordId", "deletedAt", "createdAt", "updatedAt")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.filename,
      row.storagePath,
      row.thumbnailPath,
      row.mimeType,
      row.sizeBytes,
      row.sha256,
      row.width,
      row.height,
      row.recipeId,
      row.storeId,
      row.mealRecordId,
      null,
      row.createdAt,
      row.updatedAt,
    ],
  );
  // 端侧 upsert 载荷固化真实落库主键与业务时间，未来云端重放逐行一致。
  await tx.enqueue({
    opId,
    entity: 'UploadAsset',
    entityId: row.id,
    kind: 'upsert',
    baseVersion: null,
    payload: {
      id: row.id,
      filename: row.filename,
      storagePath: row.storagePath,
      thumbnailPath: row.thumbnailPath,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      width: row.width,
      height: row.height,
      recipeId: row.recipeId,
      storeId: row.storeId,
      mealRecordId: row.mealRecordId,
      deletedAt: null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      version: 1,
    },
  });
}

export async function uploadImage(
  database: DatabaseClient,
  form: FormData,
  options: UploadServiceOptions = {},
): Promise<UploadImageResult> {
  const file = form.get('file');
  if (!(file instanceof Blob)) {
    throw new LocalApiError(422, 'INVALID_FILE', '缺少 file 图片字段');
  }
  if (file.size <= 0) throw new LocalApiError(422, 'INVALID_FILE', '图片内容为空');
  const parsed = await encodeUploadImage(file, options.encode);
  const [mainBytes, thumbBytes] = await Promise.all([
    parsed.webp.arrayBuffer(),
    parsed.thumbnail.arrayBuffer(),
  ]);
  const mainData = new Uint8Array(mainBytes);
  const thumbData = new Uint8Array(thumbBytes);
  const mainSha = await sha256Hex(mainData);

  const mainFilename = newUploadFilename('main');
  const thumbFilename = newUploadFilename('thumb');
  const storagePath = mainFilename;
  const thumbnailPath = thumbFilename;

  const files = options.files ?? defaultFiles;
  const timestamp = (options.now ?? (() => new Date()))().toISOString();
  const id = newLocalId();
  const recipeId = parseOptionalId(form.get('recipeId'), 'recipeId');
  const storeId = parseOptionalId(form.get('storeId'), 'storeId');
  const mealRecordId = parseOptionalId(form.get('mealRecordId'), 'mealRecordId');
  try {
    return await database.withWriteTransaction(async (tx) => {
      await files.writeFile({ path: mainFilename, data: mainData });
      await files.writeFile({ path: thumbFilename, data: thumbData });
      const row: AssetDbRow = {
        id,
        filename: mainFilename,
        storagePath,
        thumbnailPath,
        mimeType: 'image/webp',
        sizeBytes: mainData.byteLength,
        sha256: mainSha,
        width: parsed.width,
        height: parsed.height,
        recipeId,
        storeId,
        mealRecordId,
        deletedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await insertAsset(tx, row, newLocalId());
      return toView(row);
    });
  } catch (error) {
    await files.deleteFiles({ paths: [mainFilename, thumbFilename] }).catch(() => undefined);
    throw error;
  }
}
