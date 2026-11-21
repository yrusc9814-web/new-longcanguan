import type { CloudErrorResponse } from '@dafan/shared/sync';

export interface CloudFailure extends CloudErrorResponse {
  status: number;
}

export function cloudError({ code, status }: CloudFailure): Response {
  return Response.json({ code } satisfies CloudErrorResponse, { status });
}
