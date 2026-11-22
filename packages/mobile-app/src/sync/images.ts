/**
 * R2 图片静默队列：推送本地图片、拉取云端图片，双向去重且幂等。
 *
 * 协议（与 `packages/cloud-worker/src/image-proxy.ts` 一致）：
 * - `PUT /api/sync/images/:assetSha256?variant=main|thumb`，头带
 *   `x-household-epoch`、`content-type: image/webp`、`content-length`，
 *   thumb 额外带 `x-content-sha256`（缩略图内容哈希；主图即 assetSha256）；
 * - `GET /api/sync/images/:assetSha256?variant=...` 返回原始字节，服务端会附
 *   `x-content-sha256`，客户端据此校验落盘内容。
 *
 * 去重语义：同一 (sha256, variant) 在队列里最多一份；已存在于本地且哈希正确时
 * 直接跳过，因此重复入队、断网重试与多端广播都不会产生重复下载。
 */
import { IMAGE_CONTENT_SHA256_HEADER, IMAGE_MIME_TYPE } from '@dafan/shared/sync';

import type { UploadsFilesBridge } from '../native/upload-files.js';
import { sha256Hex } from '../modules/uploads/codec.js';
import type { SyncHttpClient } from './http.js';
import { SyncHttpError, SyncNetworkError } from './http.js';

export interface ImageAssetRef {
  /** 主图内容 SHA-256（协议里的 assetSha256）。 */
  readonly sha256: string;
  readonly storagePath: string;
  readonly thumbnailPath: string | null;
}

type Direction = 'upload' | 'download';
type Variant = 'main' | 'thumb';

interface QueueTask {
  readonly key: string;
  readonly direction: Direction;
  readonly variant: Variant;
  readonly asset: ImageAssetRef;
  attempts: number;
}

export interface ImageQueueOptions {
  readonly http: SyncHttpClient;
  readonly epoch?: number;
  readonly files: Pick<UploadsFilesBridge, 'statFile' | 'readFile' | 'writeFile'>;
  /** 单次队列处理上限，默认 32（避免长时间占用后台）。 */
  readonly batchSize?: number;
  readonly onError?: (error: unknown, task: { key: string; direction: Direction }) => void;
  readonly now?: () => number;
}

export interface ImageQueueResult {
  readonly uploaded: number;
  readonly downloaded: number;
  readonly failed: number;
}

export class ImageSyncQueue {
  private readonly tasks = new Map<string, QueueTask>();
  private running: Promise<ImageQueueResult> | null = null;

  constructor(private readonly options: ImageQueueOptions) {}

  /** 入队本地上传；主图与缩略图各自去重。 */
  enqueueUpload(asset: ImageAssetRef): void {
    this.push('upload', 'main', asset);
    if (asset.thumbnailPath) this.push('upload', 'thumb', asset);
  }

  /** 入队云端下载：先缩略图后主图，保证 UI 先有可用占位。 */
  enqueueDownload(asset: ImageAssetRef): void {
    if (asset.thumbnailPath) this.push('download', 'thumb', asset);
    this.push('download', 'main', asset);
  }

  private push(direction: Direction, variant: Variant, asset: ImageAssetRef): void {
    if (!/^[0-9a-f]{64}$/.test(asset.sha256)) return;
    const key = `${direction}:${asset.sha256}:${variant}`;
    if (this.tasks.has(key)) return;
    this.tasks.set(key, { key, direction, variant, asset, attempts: 0 });
  }

  get pending(): number {
    return this.tasks.size;
  }

  /** 串行处理队列；并发调用复用同一次处理。 */
  drain(): Promise<ImageQueueResult> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(): Promise<ImageQueueResult> {
    const result = { uploaded: 0, downloaded: 0, failed: 0 };
    const limit = this.options.batchSize ?? 32;
    let processed = 0;
    while (this.tasks.size > 0 && processed < limit) {
      const task = this.tasks.values().next().value as QueueTask | undefined;
      if (!task) break;
      this.tasks.delete(task.key);
      processed += 1;
      try {
        if (task.direction === 'upload') await this.upload(task);
        else await this.download(task);
        if (task.direction === 'upload') result.uploaded += 1;
        else result.downloaded += 1;
      } catch (error) {
        result.failed += 1;
        task.attempts += 1;
        // 网络/5xx/限流可重试；其余（4xx 业务拒绝）丢弃，避免无限重试放大。
        if (task.attempts < 5 && isRetryable(error) && !this.tasks.has(task.key)) {
          this.tasks.set(task.key, task);
        }
        this.options.onError?.(error, { key: task.key, direction: task.direction });
      }
    }
    return result;
  }

  private async upload(task: QueueTask): Promise<void> {
    const path = task.variant === 'main' ? task.asset.storagePath : task.asset.thumbnailPath;
    if (!path) return;
    const stat = await this.options.files.statFile({ path });
    if (!stat.exists || stat.size === 0) {
      throw new SyncHttpError(422, 'UPLOAD_FILE_MISSING', `本地图片缺失：${path}`);
    }
    const expected = task.variant === 'main' ? task.asset.sha256 : stat.sha256;
    if (task.variant === 'main' && stat.sha256 !== expected) {
      throw new SyncHttpError(409, 'UPLOAD_FILE_CORRUPT', `本地主图哈希不一致：${path}`);
    }
    const { data } = await this.options.files.readFile({ path });
    if (!data || data.byteLength === 0) {
      throw new SyncHttpError(422, 'UPLOAD_FILE_MISSING', `本地图片不可读：${path}`);
    }
    const actual = await sha256Hex(data);
    if (actual !== expected) {
      throw new SyncHttpError(409, 'UPLOAD_FILE_CORRUPT', `本地图片哈希不一致：${path}`);
    }

    await this.options.http.request(
      `/api/sync/images/${task.asset.sha256}?variant=${task.variant}`,
      {
        method: 'PUT',
        epoch: this.options.epoch,
        body: data as unknown as BodyInit,
        headers: {
          'content-type': IMAGE_MIME_TYPE,
          'content-length': String(data.byteLength),
          ...(task.variant === 'thumb' ? { [IMAGE_CONTENT_SHA256_HEADER]: actual } : {}),
        },
      },
    );
  }

  private async download(task: QueueTask): Promise<void> {
    const path = task.variant === 'main' ? task.asset.storagePath : task.asset.thumbnailPath;
    if (!path) return;
    const existing = await this.options.files.statFile({ path });
    if (existing.exists && (task.variant === 'thumb' || existing.sha256 === task.asset.sha256)) {
      return;
    }

    const response = await this.options.http.requestRaw(topicPath(task));
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) throw new SyncHttpError(422, 'INVALID_FILE', '图片内容为空');

    const actual = await sha256Hex(bytes);
    const expected =
      task.variant === 'main'
        ? task.asset.sha256
        : response.headers.get(IMAGE_CONTENT_SHA256_HEADER);
    if (expected && actual !== expected) {
      throw new SyncHttpError(409, 'UPLOAD_FILE_CORRUPT', `下载图片哈希不一致：${path}`);
    }
    await this.options.files.writeFile({ path, data: bytes });
  }
}

function topicPath(task: QueueTask): string {
  return `/api/sync/images/${task.asset.sha256}?variant=${task.variant}`;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof SyncNetworkError) return true;
  if (error instanceof SyncHttpError) {
    return error.status === 429 || error.status >= 500;
  }
  return false;
}

export function createImageSyncQueue(options: ImageQueueOptions): ImageSyncQueue {
  return new ImageSyncQueue(options);
}
