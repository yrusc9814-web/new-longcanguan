import type { HouseholdMemberStatus, HouseholdRole } from '@dafan/shared/sync';

import type { CloudFailure, MemberRevokedFailure } from './http';

export type HouseholdPrincipal = {
  id: string;
  nickname: string;
  role: HouseholdRole;
  status: HouseholdMemberStatus;
};

const CREDENTIAL_BYTES = 32;
const BEARER_PATTERN = /^Bearer +([A-Za-z0-9._~+/-]{1,2048}={0,2})$/i;

/** SHA-256(明文) 的小写十六进制。所有落库凭证只保存该哈希。 */
export async function hashCredential(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return toHex(new Uint8Array(digest));
}

/** 32 字节随机凭证，base64url 无填充。 */
export function generateCredential(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CREDENTIAL_BYTES));
  return toBase64Url(bytes);
}

/**
 * 固定长度比较已知凭证与候选凭证。
 *
 * 缺失或空值直接失败（fail closed）；两端先各自 SHA-256 后再用
 * `crypto.subtle.timingSafeEqual` 比较，避免长度差异泄露信息。
 */
export async function constantTimeSecretMatches(
  known: string | undefined,
  provided: string,
): Promise<boolean> {
  if (!known || !provided) return false;
  const encoder = new TextEncoder();
  const [knownDigest, providedDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(known)),
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
  ]);
  return crypto.subtle.timingSafeEqual(knownDigest, providedDigest);
}

export async function hashBearer(authorization: string | null): Promise<string | null> {
  const match = authorization?.match(BEARER_PATTERN);
  if (!match) return null;
  return hashCredential(match[1]);
}

/** 用 household_meta 中的家庭 ID 构造精确撤权错误。 */
export function memberRevoked(sql: SqlStorage, memberId: string): MemberRevokedFailure {
  const meta = sql
    .exec<{ household_id: string }>('SELECT household_id FROM household_meta WHERE id = 1')
    .toArray()[0];
  if (!meta) throw new Error('household_meta is not initialized');
  return { code: 'MEMBER_REVOKED', status: 403, householdId: meta.household_id, memberId };
}

export function requireMember(
  sql: SqlStorage,
  tokenHash: string | null,
  requiredRole?: HouseholdRole,
): HouseholdPrincipal | CloudFailure {
  const member = tokenHash
    ? sql
        .exec<HouseholdPrincipal>(
          'SELECT id, nickname, role, status FROM household_members WHERE token_hash = ?',
          tokenHash,
        )
        .toArray()[0]
    : undefined;

  if (!member) return { code: 'UNAUTHORIZED', status: 401 };
  if (member.status === 'REVOKED') return memberRevoked(sql, member.id);
  if (requiredRole && member.role !== requiredRole) return { code: 'FORBIDDEN', status: 403 };
  return member;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
