import { IMAGE_MIME_TYPE, MAX_IMAGE_BYTES, type ImageMetadata } from '@dafan/shared/sync';

import type { CloudFailure } from './http';

export interface ImageTarget {
  assetSha256: string;
  variant: string | null;
}

export interface ImageUploadRequest extends ImageTarget {
  epoch: string | null;
  contentType: string | null;
  contentLength: string | null;
  contentSha256: string | null;
}

export interface PendingImageUpload extends ImageMetadata {
  epoch: number;
  objectKey: string;
}

export type ImagePreflight =
  { kind: 'existing' } | { kind: 'upload'; upload: PendingImageUpload } | CloudFailure;

export type ImageCommit = { kind: 'registered' | 'existing' } | CloudFailure;
export type ImageRead = { kind: 'found'; objectKey: string; contentSha256: string } | CloudFailure;

export function parseImageTarget({ assetSha256, variant }: ImageTarget) {
  const resolvedVariant = variant ?? 'main';
  if (!isSha256(assetSha256) || (resolvedVariant !== 'main' && resolvedVariant !== 'thumb')) {
    return null;
  }
  return { assetSha256, variant: resolvedVariant } as const;
}

export function parseImageUpload(request: ImageUploadRequest): ImageMetadata | CloudFailure {
  const target = parseImageTarget(request);
  if (!target) return { code: 'VALIDATION_ERROR', status: 400 };

  const { assetSha256, variant } = target;
  const contentSha256 = variant === 'main' ? assetSha256 : request.contentSha256;
  if (!contentSha256 || !isSha256(contentSha256)) {
    return { code: 'VALIDATION_ERROR', status: 400 };
  }
  if (request.contentType?.toLowerCase() !== IMAGE_MIME_TYPE) {
    return { code: 'INVALID_FILE', status: 415 };
  }
  if (!request.contentLength || !/^\d+$/.test(request.contentLength)) {
    return { code: 'INVALID_FILE', status: 400 };
  }
  const sizeBytes = Number(request.contentLength);
  if (sizeBytes > MAX_IMAGE_BYTES) return { code: 'FILE_TOO_LARGE', status: 413 };
  if (sizeBytes === 0) return { code: 'INVALID_FILE', status: 400 };

  return { assetSha256, variant, contentSha256, sizeBytes, mimeType: IMAGE_MIME_TYPE };
}

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}
