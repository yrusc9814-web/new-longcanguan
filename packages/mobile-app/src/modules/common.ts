import type { PaginationResponse } from '@dafan/shared/types';
import { LocalApiError, readJsonBody } from '../local-api/protocol.js';

export function validationError(message: string): LocalApiError {
  return new LocalApiError(400, 'VALIDATION_ERROR', message);
}

export async function readObject(
  request: Request,
  optional = false,
): Promise<Record<string, unknown>> {
  if (optional && request.body === null) return {};
  const body = await readJsonBody<unknown>(request);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw validationError('请求体必须是 JSON 对象');
  }
  return body as Record<string, unknown>;
}

export function requireVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw validationError('version 必须为正整数');
  }
  return value;
}

export function queryVersion(query: URLSearchParams): number {
  const version = query.get('version');
  return requireVersion(version && /^[1-9][0-9]*$/.test(version) ? Number(version) : undefined);
}

function parsePositiveInteger(value: string | null, field: string): number | undefined {
  if (value === null) return undefined;
  if (!/^[1-9][0-9]{0,8}$/.test(value)) {
    throw validationError(`${field} 必须为正整数`);
  }
  return Number(value);
}

export interface PageOptions {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

export function pageOptions(query: URLSearchParams, maxPageSize = 100): PageOptions {
  const page = parsePositiveInteger(query.get('page'), 'page') ?? 1;
  const pageSize = Math.min(
    maxPageSize,
    parsePositiveInteger(query.get('pageSize'), 'pageSize') ?? 20,
  );
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

export function paginated<T>(
  items: T[],
  total: number,
  { page, pageSize }: PageOptions,
): PaginationResponse<T> {
  return { items, page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}

/** 按设备日历取日期，避免 UTC 换日提前或延迟库存过期。 */
export function localDate(date: Date, offsetDays = 0): string {
  const dayOnCalendar = new Date(date.getTime());
  dayOnCalendar.setDate(dayOnCalendar.getDate() + offsetDays);
  const year = String(dayOnCalendar.getFullYear()).padStart(4, '0');
  const month = String(dayOnCalendar.getMonth() + 1).padStart(2, '0');
  const day = String(dayOnCalendar.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function sqlBoolean(value: number | boolean): boolean {
  return value === 1 || value === true;
}
