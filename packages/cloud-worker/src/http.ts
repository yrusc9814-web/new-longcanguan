import type {
  CloudErrorCode,
  CloudErrorResponse,
  EpochMismatchResponse,
  MemberRevokedResponse,
} from '@dafan/shared/sync';

/** 普通失败：响应体只有 code，可按需附带 Retry-After 秒数。 */
type CloudErrorFailure =
  | {
      readonly code: Exclude<CloudErrorCode, 'MEMBER_REVOKED' | 'RATE_LIMITED' | 'EPOCH_MISMATCH'>;
      readonly status: number;
    }
  | (EpochMismatchResponse & { readonly status: 409 })
  | { readonly code: 'RATE_LIMITED'; readonly status: 429; readonly retryAfter: number };

/** 撤权失败必须锚定 householdId 与 memberId，客户端据此清理本地数据。 */
export type MemberRevokedFailure = MemberRevokedResponse & {
  readonly status: 403;
};

export type CloudFailure = CloudErrorFailure | MemberRevokedFailure;

export function cloudError(failure: CloudFailure): Response {
  const headers: Record<string, string> = { 'cache-control': 'no-store' };
  if (failure.code === 'MEMBER_REVOKED') {
    const body: MemberRevokedResponse = {
      code: failure.code,
      householdId: failure.householdId,
      memberId: failure.memberId,
    };
    return Response.json(body, { status: failure.status, headers });
  }

  if (failure.code === 'EPOCH_MISMATCH') {
    const body: EpochMismatchResponse = { code: failure.code, currentEpoch: failure.currentEpoch };
    return Response.json(body, { status: failure.status, headers });
  }

  if (failure.code === 'RATE_LIMITED') {
    headers['retry-after'] = String(failure.retryAfter);
  }
  const body: CloudErrorResponse = { code: failure.code };
  return Response.json(body, { status: failure.status, headers });
}
