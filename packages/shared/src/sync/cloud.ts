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
  | 'RATE_LIMITED'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR'
>;

/** 撤权失败必须锚定到具体家庭与成员，客户端据此清理本地数据。 */
export interface MemberRevokedResponse {
  readonly code: 'MEMBER_REVOKED';
  readonly householdId: string;
  readonly memberId: string;
}

export type CloudErrorResponse =
  { readonly code: Exclude<CloudErrorCode, 'MEMBER_REVOKED'> } | MemberRevokedResponse;

export interface ImageMetadata {
  readonly assetSha256: string;
  readonly variant: ImageVariant;
  readonly contentSha256: string;
  readonly mimeType: typeof IMAGE_MIME_TYPE;
  readonly sizeBytes: number;
}

/** 首次初始化家庭的请求；bootstrapSecret 由部署方掌握。 */
export interface HouseholdInitRequest {
  readonly bootstrapSecret: string;
  readonly nickname: string;
}

/** 所有者恢复访问；昵称可留给服务端沿用旧值。 */
export interface HouseholdOwnerRecoverRequest {
  readonly bootstrapSecret: string;
  readonly nickname?: string;
}

export interface HouseholdJoinRequest {
  readonly inviteCode: string;
  readonly nickname: string;
}

export interface HouseholdIdentity {
  readonly householdId: string;
  readonly epoch: number;
  readonly memberId: string;
  readonly role: HouseholdRole;
  readonly nickname: string;
}

export interface HouseholdBinding extends HouseholdIdentity {
  readonly token: string;
}

export interface HouseholdMember {
  readonly id: string;
  readonly nickname: string;
  readonly role: HouseholdRole;
  readonly status: HouseholdMemberStatus;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

export interface HouseholdMembersResponse {
  readonly members: readonly HouseholdMember[];
}

export interface HouseholdInviteResponse {
  readonly inviteCode: string;
  readonly expiresAt: string;
}

export interface WebSocketTicketResponse {
  readonly ticket: string;
  readonly expiresAt: string;
}

/** 服务端在连接上推送的撤权通知帧。 */
export interface MemberRevokedFrame {
  readonly type: 'MEMBER_REVOKED';
  readonly householdId: string;
  readonly memberId: string;
}

export type CloudServerFrame = MemberRevokedFrame;
