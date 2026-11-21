/**
 * 上传媒体编解码：真实 WebP 压缩、EXIF 方向正置与 SHA-256。
 *
 * 职责边界：
 * - `decodeOrientedBitmap`：按 `imageOrientation: 'from-image'` 解码，浏览器负责消费
 *   EXIF Orientation（非 1 的竖拍图解码后宽高即正置），Node 测试桩可注入同形实现；
 * - `encodeWebp`：通过 OffscreenCanvas/Canvas `convertToBlob`/`toBlob` 真实产出 WebP；
 * - `sha256Hex`：Web Crypto 真实摘要；
 * - 校验一律 fail-closed：类型、大小、维度不合格直接抛 `LocalApiError`。
 */
import { LocalApiError } from '../../local-api/protocol.js';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_DIMENSION = 4096;
export const THUMBNAIL_MAX_EDGE = 320;
export const THUMBNAIL_QUALITY = 0.7;
export const IMAGE_QUALITY = 0.85;

export interface DecodedBitmap {
  readonly width: number;
  readonly height: number;
  /** 把位图重新画到目标尺寸画布上（源已按 EXIF 正置）。 */
  readonly drawTo: (context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) => void;
  readonly close: () => void;
}

export interface BitmapDecoder {
  (blob: Blob): Promise<DecodedBitmap>;
}

type CanvasProvider = () => {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  toWebp: (quality: number) => Promise<Blob>;
};

interface ImageBitmapLike {
  width: number;
  height: number;
  close?: () => void;
}

/** 真实解码：`createImageBitmap(blob, { imageOrientation: 'from-image' })` 消费 EXIF。 */
export const defaultBitmapDecoder: BitmapDecoder = async (blob) => {
  if (typeof createImageBitmap !== 'function') {
    throw new LocalApiError(422, 'INVALID_FILE', '当前环境不支持图片解码');
  }
  let bitmap: ImageBitmapLike;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    throw new LocalApiError(422, 'INVALID_FILE', '无法解码图片文件');
  }
  return {
    width: bitmap.width,
    height: bitmap.height,
    drawTo(context) {
      context.drawImage(bitmap as CanvasImageSource, 0, 0);
    },
    close() {
      bitmap.close?.();
    },
  };
};

export function createCanvasProvider(): CanvasProvider {
  if (typeof OffscreenCanvas === 'function') {
    return () => {
      const canvas = new OffscreenCanvas(1, 1);
      const context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
      if (!context) throw new LocalApiError(500, 'INTERNAL_ERROR', '无法创建画布上下文');
      return {
        canvas,
        context,
        toWebp: (quality) =>
          canvas.convertToBlob({ type: 'image/webp', quality }).then((blob) => {
            if (blob.type !== 'image/webp') {
              throw new LocalApiError(500, 'INTERNAL_ERROR', '当前环境无法编码 WebP');
            }
            return blob;
          }),
      };
    };
  }
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    return () => {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (!context) throw new LocalApiError(500, 'INTERNAL_ERROR', '无法创建画布上下文');
      return {
        canvas,
        context,
        toWebp: (quality) =>
          new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(
              (blob) => {
                if (!blob || blob.type !== 'image/webp') {
                  reject(new LocalApiError(500, 'INTERNAL_ERROR', '当前环境无法编码 WebP'));
                  return;
                }
                resolve(blob);
              },
              'image/webp',
              quality,
            );
          }),
      };
    };
  }
  throw new LocalApiError(500, 'INTERNAL_ERROR', '当前环境不支持图片编码');
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface ParsedUploadImage {
  readonly webp: Blob;
  readonly thumbnail: Blob;
  readonly width: number;
  readonly height: number;
  readonly thumbWidth: number;
  readonly thumbHeight: number;
}

/** 缩略图最长边 = THUMBNAIL_MAX_EDGE，小图原尺寸。 */
function thumbnailEdge(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= THUMBNAIL_MAX_EDGE) return { width, height };
  const scale = THUMBNAIL_MAX_EDGE / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export interface EncodeUploadOptions {
  readonly decoder?: BitmapDecoder;
  readonly canvasProvider?: CanvasProvider;
  /** 直接注入已产出的二进制（仅测试桩使用；跳过画布路径）。 */
  readonly encode?: (bitmap: DecodedBitmap) => Promise<{ webp: Blob; thumbnail: Blob }>;
}

export async function encodeUploadImage(
  blob: Blob,
  options: EncodeUploadOptions = {},
): Promise<ParsedUploadImage> {
  if (blob.size <= 0) throw new LocalApiError(422, 'INVALID_FILE', '图片内容为空');
  if (blob.size > MAX_UPLOAD_BYTES) {
    throw new LocalApiError(413, 'FILE_TOO_LARGE', '图片超过 10MB 上限');
  }
  const decode = options.decoder ?? defaultBitmapDecoder;
  const bitmap = await decode(blob);
  try {
    if (bitmap.width <= 0 || bitmap.height <= 0) {
      throw new LocalApiError(422, 'INVALID_FILE', '图片维度无效');
    }
    if (bitmap.width > MAX_UPLOAD_DIMENSION || bitmap.height > MAX_UPLOAD_DIMENSION) {
      throw new LocalApiError(422, 'INVALID_FILE', '图片尺寸超过 4096px 上限');
    }
    if (options.encode) {
      const direct = await options.encode(bitmap);
      return {
        webp: direct.webp,
        thumbnail: direct.thumbnail,
        width: bitmap.width,
        height: bitmap.height,
        thumbWidth: bitmap.width,
        thumbHeight: bitmap.height,
      };
    }
    const provider = options.canvasProvider ?? createCanvasProvider();
    const main = provider();
    main.canvas.width = bitmap.width;
    main.canvas.height = bitmap.height;
    bitmap.drawTo(main.context);
    const thumbEdge = thumbnailEdge(bitmap.width, bitmap.height);
    const thumb = provider();
    thumb.canvas.width = thumbEdge.width;
    thumb.canvas.height = thumbEdge.height;
    const thumbContext = thumb.context as CanvasRenderingContext2D;
    thumbContext.imageSmoothingEnabled = true;
    thumbContext.drawImage(
      main.canvas as CanvasImageSource,
      0,
      0,
      bitmap.width,
      bitmap.height,
      0,
      0,
      thumbEdge.width,
      thumbEdge.height,
    );
    const [webp, thumbnail] = await Promise.all([
      main.toWebp(IMAGE_QUALITY),
      thumb.toWebp(THUMBNAIL_QUALITY),
    ]);
    return {
      webp,
      thumbnail,
      width: bitmap.width,
      height: bitmap.height,
      thumbWidth: thumbEdge.width,
      thumbHeight: thumbEdge.height,
    };
  } finally {
    bitmap.close();
  }
}

/** 主图 / 缩略图文件名：毫秒级时间戳 + 随机短串，恒为 `/uploads/xxx.webp` 形态。 */
export function newUploadFilename(prefix: 'main' | 'thumb'): string {
  const random = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return `${prefix}-${Date.now().toString(36)}-${random}.webp`;
}

export const UPLOADS_URL_PREFIX = '/uploads/';

export function uploadsUrl(filename: string): string {
  return `${UPLOADS_URL_PREFIX}${filename}`;
}

/**
 * 断言记录里的照片路径都指向已登记的有效 UploadAsset。
 *
 * 返回缺失的路径列表；空数组代表全部通过。路径协议：`/uploads/<filename>`，
 * 文件名只允许 `[A-Za-z0-9._-]`（与原生 UploadsPathPolicy 白名单一致）。
 */
export function extractUploadedFilenames(photos: readonly string[]): string[] {
  const filenames: string[] = [];
  for (const entry of photos) {
    if (typeof entry !== 'string' || !entry.startsWith(UPLOADS_URL_PREFIX)) continue;
    const filename = entry.slice(UPLOADS_URL_PREFIX.length);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.webp$/.test(filename)) continue;
    filenames.push(filename);
  }
  return filenames;
}
