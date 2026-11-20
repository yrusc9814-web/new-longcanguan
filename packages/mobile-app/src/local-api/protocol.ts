/**
 * 本地 API 的线协议：与云端一致的 success/data/error 信封、错误类型与响应构造器。
 *
 * 该模块不依赖数据库、Capacitor 或任何 native 桥接，便于在 WebView、Node 测试
 * 以及后续 Native Bridge 中复用。
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE'];

export function isHttpMethod(value: string): value is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(value);
}

export interface LocalApiErrorBody {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export interface LocalApiSuccess<T> {
  readonly success: true;
  readonly data: T;
  readonly error: null;
}

export interface LocalApiFailure {
  readonly success: false;
  readonly data: null;
  readonly error: LocalApiErrorBody;
}

export type LocalApiEnvelope<T> = LocalApiSuccess<T> | LocalApiFailure;

export interface LocalApiErrorOptions {
  readonly details?: Record<string, unknown>;
  readonly headers?: Record<string, string>;
}

/** 可直接映射为 HTTP 响应的业务错误。 */
export class LocalApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly headers: Record<string, string>;

  constructor(status: number, code: string, message: string, options: LocalApiErrorOptions = {}) {
    super(message);
    this.name = 'LocalApiError';
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.headers = { ...(options.headers ?? {}) };
  }
}

export function localApiError(
  status: number,
  code: string,
  message: string,
  options: LocalApiErrorOptions = {},
): LocalApiError {
  return new LocalApiError(status, code, message, options);
}

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

function mergeHeaders(
  base: Record<string, string>,
  extra?: Record<string, string>,
): Record<string, string> {
  return { ...base, ...(extra ?? {}) };
}

function jsonResponse(
  payload: LocalApiEnvelope<unknown>,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: mergeHeaders({ 'content-type': JSON_CONTENT_TYPE }, headers),
  });
}

export function successResponse<T>(
  data: T,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return jsonResponse({ success: true, data, error: null }, status, headers);
}

export function failureResponse(
  status: number,
  code: string,
  message: string,
  options: LocalApiErrorOptions = {},
): Response {
  return jsonResponse(
    { success: false, data: null, error: { code, message, details: options.details } },
    status,
    options.headers,
  );
}

/** 处理器返回普通数据时的显式包装，允许指定状态码与额外响应头。 */
export class LocalApiDataResult {
  constructor(
    readonly data: unknown,
    readonly status = 200,
    readonly headers: Record<string, string> = {},
  ) {}
}

/** 处理器返回二进制时的包装（备份导出等）。 */
export class LocalApiBlobResult {
  constructor(
    readonly blob: Blob,
    readonly status = 200,
    readonly headers: Record<string, string> = {},
  ) {}
}

export interface LocalApiResultInit {
  readonly status?: number;
  readonly headers?: Record<string, string>;
}

export function dataResult(data: unknown, init: LocalApiResultInit = {}): LocalApiDataResult {
  return new LocalApiDataResult(data, init.status ?? 200, init.headers ?? {});
}

export function blobResult(blob: Blob, init: LocalApiResultInit = {}): LocalApiBlobResult {
  return new LocalApiBlobResult(blob, init.status ?? 200, init.headers ?? {});
}

export interface LocalApiRequestContext {
  readonly request: Request;
  readonly method: HttpMethod;
  readonly url: URL;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
}

export type LocalApiHandler = (context: LocalApiRequestContext) => unknown;

/**
 * 原生 Request 已经是标准 Body 载体：处理器可以直接使用 request.json()、
 * request.formData()、request.text() 或 request.arrayBuffer()。这两个包装只负责
 * 把解析失败转换成统一的 400 VALIDATION_ERROR。
 */
export async function readJsonBody<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw localApiError(400, 'VALIDATION_ERROR', '请求体必须是合法的 JSON');
  }
}

export async function readFormDataBody(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    throw localApiError(400, 'VALIDATION_ERROR', '请求体必须是 multipart/form-data');
  }
}
