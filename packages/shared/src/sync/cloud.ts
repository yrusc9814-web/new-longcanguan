import type { ApiErrorCode } from '../types/api.js';

export const HOUSEHOLD_EPOCH_HEADER = 'x-household-epoch';
export const IMAGE_CONTENT_SHA256_HEADER = 'x-content-sha256';
export const IMAGE_MIME_TYPE = 'image/webp';
export const MAX_IMAGE_BYTES = 10_485_760;

export type HouseholdRole = 'OWNER' | 'MEMBER';
export type HouseholdMemberStatus = 'ACTIVE' | 'REVOKED';
export type ImageVariant = 'main' | 'thumb';

export type CloudErrorCode = Extract<
  ApiErrorCode,
  | 'UNAUTHORIZED'
  | 'MEMBER_REVOKED'
  | 'FORBIDDEN'
  | 'EPOCH_MISMATCH'
  | 'VALIDATION_ERROR'
  | 'FILE_TOO_LARGE'
  | 'INVALID_FILE'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR'
>;

export interface CloudErrorResponse {
  readonly code: CloudErrorCode;
}

export interface ImageMetadata {
  readonly assetSha256: string;
  readonly variant: ImageVariant;
  readonly contentSha256: string;
  readonly mimeType: typeof IMAGE_MIME_TYPE;
  readonly sizeBytes: number;
}
