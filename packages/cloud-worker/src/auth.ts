import type { HouseholdMemberStatus, HouseholdRole } from '@dafan/shared/sync';

import type { CloudFailure } from './http';

export type HouseholdPrincipal = {
  id: string;
  role: HouseholdRole;
  status: HouseholdMemberStatus;
};

export async function hashBearer(authorization: string | null): Promise<string | null> {
  const match = authorization?.match(/^Bearer +([A-Za-z0-9._~+/-]{1,2048}={0,2})$/i);
  if (!match) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(match[1]));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function requireMember(
  sql: SqlStorage,
  tokenHash: string | null,
  requiredRole?: HouseholdRole,
): HouseholdPrincipal | CloudFailure {
  const member = tokenHash
    ? sql
        .exec<HouseholdPrincipal>(
          'SELECT id, role, status FROM household_members WHERE token_hash = ?',
          tokenHash,
        )
        .toArray()[0]
    : undefined;

  if (!member) return { code: 'UNAUTHORIZED', status: 401 };
  if (member.status === 'REVOKED') return { code: 'MEMBER_REVOKED', status: 403 };
  if (requiredRole && member.role !== requiredRole) return { code: 'FORBIDDEN', status: 403 };
  return member;
}
