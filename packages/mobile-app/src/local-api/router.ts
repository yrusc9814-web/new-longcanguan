import { RETAINED_ENDPOINTS, RETIRED_ENDPOINTS } from '@dafan/shared/contracts';
import type { HealthData } from '@dafan/shared/types';
import { DatabaseError, VersionConflictError } from '../db/errors.js';

import {
  LocalApiBlobResult,
  LocalApiDataResult,
  LocalApiError,
  failureResponse,
  isHttpMethod,
  successResponse,
  type HttpMethod,
  type LocalApiHandler,
  type LocalApiRequestContext,
} from './protocol.js';

/** 仅拦截该前缀下的同源请求；外源请求原样交回原生 fetch。 */
export const LOCAL_API_PREFIX = '/api/v1';

/** Google2 适配器读取的 PIN 头。 */
export const PIN_TOKEN_HEADER = 'x-app-pin-token';

const HEALTH_APP_NAME = '搭饭小馆';
const HEALTH_APP_VERSION = '0.1.0';
const DEFAULT_FETCH_ORIGIN = 'http://localhost';

/** 免 PIN 锁的端点：仅这些方法+路径组合可跳过 x-app-pin-token 校验。 */
export const PIN_EXEMPT_ENDPOINTS: ReadonlySet<string> = new Set([
  'GET /api/v1/health',
  'GET /api/v1/settings',
  'GET /api/v1/settings/pin/session',
  'POST /api/v1/settings/pin/verify',
  'POST /api/v1/settings/high-risk/authorize',
  'POST /api/v1/backups/restore',
]);

export interface LocalApiGateState {
  /** 成员被移除、待清空本地数据时必须先于其他检查阻断。 */
  readonly pendingWipe: boolean;
  /** 是否已启用 PIN 锁。 */
  readonly pinRequired: boolean;
}

export interface LocalApiDatabaseProbeResult {
  readonly status: 'ok' | 'error';
}

export type LocalApiDatabaseProbe = () =>
  LocalApiDatabaseProbeResult | Promise<LocalApiDatabaseProbeResult>;

export interface LocalApiRouterOptions {
  /**
   * 读取当前门禁状态。默认视为已启用 PIN 且无待清空任务：
   * 必须注入真实实现，否则除免锁端点外一律 401。
   */
  readonly readGateState?: () => LocalApiGateState | Promise<LocalApiGateState>;
  /**
   * 校验 x-app-pin-token。默认 fail closed（一律无效）。
   * 抛错同样按无效处理，避免验证故障时放行。
   */
  readonly isPinTokenValid?: (token: string) => boolean | Promise<boolean>;
  /** 数据库不可用或未注入探针时返回 503 DATABASE_ERROR。 */
  readonly healthDatabaseProbe?: LocalApiDatabaseProbe;
  readonly onMutation?: () => void;
  /** 时间源，便于测试固定 timestamp。 */
  readonly now?: () => Date;
}

interface Segment {
  readonly literal?: string;
  readonly param?: string;
}

interface CompiledRoute {
  readonly method: HttpMethod;
  readonly path: string;
  readonly segments: readonly Segment[];
  readonly staticCount: number;
}

interface RegisteredRoute extends CompiledRoute {
  readonly handler: LocalApiHandler;
}

function compileRoute({ method, path }: { method: string; path: string }): CompiledRoute {
  const parts = path.split('/').filter((part) => part.length > 0);
  const segments = parts.map<Segment>((part) =>
    part.startsWith(':') ? { param: part.slice(1) } : { literal: part },
  );
  return {
    method: method as HttpMethod,
    path,
    segments,
    staticCount: segments.filter((segment) => segment.literal !== undefined).length,
  };
}

/** 静态段多者优先，避免 /stores/candidates 被 /stores/:id 抢先。 */
function compareRoutes(left: CompiledRoute, right: CompiledRoute): number {
  return right.staticCount - left.staticCount || right.segments.length - left.segments.length;
}

const RETIRED_ROUTES = RETIRED_ENDPOINTS.map(compileRoute);

const RETAINED_ROUTES: readonly CompiledRoute[] =
  RETAINED_ENDPOINTS.map(compileRoute).sort(compareRoutes);

function matchRoute(
  route: CompiledRoute,
  method: string,
  parts: readonly string[],
): Record<string, string> | null {
  if (route.method !== method || route.segments.length !== parts.length) return null;
  return matchPath(route, parts);
}

/** 只比较路径形状，忽略方法。 */
function matchPath(route: CompiledRoute, parts: readonly string[]): Record<string, string> | null {
  if (route.segments.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < route.segments.length; index += 1) {
    const segment = route.segments[index];
    const value = parts[index];
    if (segment.literal !== undefined) {
      if (segment.literal !== value) return null;
      continue;
    }
    if (!value) return null;
    try {
      params[segment.param as string] = decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return params;
}

function pathParts(pathname: string): string[] {
  return pathname.split('/').filter((part) => part.length > 0);
}

/** 免锁白名单与路由同一形状：忽略多余的尾斜杠。 */
function normalizePathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.replace(/\/+$/, '');
  return pathname;
}

function methodNotAllowed(method: string, path: string): LocalApiError {
  return new LocalApiError(405, 'METHOD_NOT_ALLOWED', `不支持的方法 ${method}：${path}`, {
    headers: { allow: 'GET, POST, PUT, DELETE' },
  });
}

function resolveHandlerResult(result: unknown): Response {
  if (result instanceof Response) return result;
  if (result instanceof LocalApiBlobResult) {
    const contentType = result.blob.type || 'application/octet-stream';
    return new Response(result.blob, {
      status: result.status,
      headers: { 'content-type': contentType, ...result.headers },
    });
  }
  if (result instanceof LocalApiDataResult) {
    return successResponse(result.data ?? null, result.status, result.headers);
  }
  return successResponse(result ?? null);
}

function healthHandler(options: LocalApiRouterOptions): LocalApiHandler {
  return async () => {
    let ready: boolean;
    try {
      ready = (await options.healthDatabaseProbe?.())?.status === 'ok';
    } catch {
      ready = false;
    }
    if (!ready) throw new LocalApiError(503, 'DATABASE_ERROR', '数据库不可用');
    const now = options.now ?? (() => new Date());
    const data: HealthData = {
      status: 'ok',
      app: HEALTH_APP_NAME,
      version: HEALTH_APP_VERSION,
      database: { status: 'ok', provider: 'sqlite' },
      timestamp: now().toISOString(),
    };
    return data;
  };
}

/**
 * 本地 `/api/v1` 路由：固定 404 退役端点，其余走门禁与可注册业务处理器。
 * 不触碰数据库、Capacitor 或 Native 桥接，集成时只需注入门禁读取与 PIN 校验。
 */
export class LocalApiRouter {
  readonly options: LocalApiRouterOptions;

  private readonly routes = new Map<string, RegisteredRoute>();

  private readonly sortedRoutes: RegisteredRoute[] = [];

  constructor(options: LocalApiRouterOptions = {}) {
    this.options = options;
    this.register('GET', '/api/v1/health', healthHandler(options));
  }

  /** 注册业务处理器；重复注册同一 method+path 会立即报错，避免静默覆盖。 */
  register(method: HttpMethod, path: string, handler: LocalApiHandler): this {
    if (!path.startsWith(`${LOCAL_API_PREFIX}/`)) {
      throw new Error(`本地 API 路径必须位于 ${LOCAL_API_PREFIX}/ 下：${path}`);
    }
    const key = `${method} ${path}`;
    if (this.routes.has(key)) throw new Error(`重复注册本地 API 路由：${key}`);
    const route: RegisteredRoute = { ...compileRoute({ method, path }), handler };
    this.routes.set(key, route);
    this.sortedRoutes.push(route);
    this.sortedRoutes.sort(compareRoutes);
    return this;
  }

  unregister(method: HttpMethod, path: string): boolean {
    if (!this.routes.delete(`${method} ${path}`)) return false;
    const index = this.sortedRoutes.findIndex(
      (route) => route.method === method && route.path === path,
    );
    if (index >= 0) this.sortedRoutes.splice(index, 1);
    return true;
  }

  has(method: HttpMethod, path: string): boolean {
    return this.routes.has(`${method} ${path}`);
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const path = normalizePathname(url.pathname);
    const parts = pathParts(path);

    try {
      // 守卫优先于一切路由匹配：待清空状态下任何本地请求都不得继续。
      const gate = await this.readGateState();
      if (gate.pendingWipe) {
        throw new LocalApiError(403, 'MEMBER_REVOKED', '成员权限已移除，本地数据待清空');
      }

      if (await this.pinLocked(request, method, path, gate)) {
        throw new LocalApiError(401, 'UNAUTHORIZED', '需要有效的 PIN 解锁凭证');
      }

      if (this.matchRetired(method, parts)) {
        return failureResponse(404, 'NOT_FOUND', `未找到本地端点：${method} ${path}`);
      }
      if (!isHttpMethod(method)) throw methodNotAllowed(method, path);

      const registered = this.matchRegistered(method, parts);
      const retained = registered ? null : this.matchRetained(method, parts);

      // 路径存在但方法不同 → 405，避免被误报为未知端点。
      if (!registered && !retained && this.pathExists(parts)) {
        throw methodNotAllowed(method, path);
      }

      if (registered) {
        const context = this.createContext(request, method, path, url, registered.params);
        const result = await registered.route.handler(context);
        if ((await this.readGateState()).pendingWipe) {
          throw new LocalApiError(403, 'MEMBER_REVOKED', '成员权限已移除，本地数据待清空');
        }
        const response = resolveHandlerResult(result);
        if (response.ok && method !== 'GET') this.options.onMutation?.();
        return response;
      }

      if (retained) {
        return failureResponse(
          501,
          'NOT_IMPLEMENTED',
          `本地端点尚未实现：${method} ${retained.path}`,
        );
      }

      return failureResponse(404, 'NOT_FOUND', `未找到本地端点：${method} ${path}`);
    } catch (error) {
      return this.errorResponse(error, method, path);
    }
  }

  private errorResponse(error: unknown, method: string, path: string): Response {
    if (error instanceof LocalApiError) {
      return failureResponse(error.status, error.code, error.message, {
        details: error.details,
        headers: error.headers,
      });
    }
    if (error instanceof VersionConflictError) {
      const { entity, id, expectedVersion, actualVersion } = error;
      return failureResponse(409, 'VERSION_CONFLICT', error.message, {
        details: { entity, id, expectedVersion, actualVersion },
      });
    }
    if (error instanceof DatabaseError && error.code === 'NOT_FOUND') {
      return failureResponse(404, 'NOT_FOUND', '未找到本地数据');
    }
    if (error instanceof DatabaseError && error.code === 'BUSY') {
      return failureResponse(503, 'DATABASE_ERROR', '数据库暂不可用');
    }
    return failureResponse(500, 'INTERNAL_ERROR', `本地服务处理 ${method} ${path} 时失败`);
  }

  private matchRetired(method: string, parts: readonly string[]): CompiledRoute | null {
    for (const route of RETIRED_ROUTES) {
      if (matchRoute(route, method, parts)) return route;
    }
    return null;
  }

  private matchRegistered(
    method: string,
    parts: readonly string[],
  ): { route: RegisteredRoute; params: Record<string, string> } | null {
    for (const route of this.sortedRoutes) {
      const params = matchRoute(route, method, parts);
      if (params) return { route, params };
    }
    return null;
  }

  /** 是否存在同形状路径（与请求方法无关）。 */
  private pathExists(parts: readonly string[]): boolean {
    for (const route of RETIRED_ROUTES) {
      if (matchPath(route, parts)) return true;
    }
    for (const route of this.sortedRoutes) {
      if (matchPath(route, parts)) return true;
    }
    for (const route of RETAINED_ROUTES) {
      if (matchPath(route, parts)) return true;
    }
    return false;
  }

  private matchRetained(method: string, parts: readonly string[]): CompiledRoute | null {
    for (const route of RETAINED_ROUTES) {
      if (matchRoute(route, method, parts)) return route;
    }
    return null;
  }

  private createContext(
    request: Request,
    method: HttpMethod,
    path: string,
    url: URL,
    params: Record<string, string>,
  ): LocalApiRequestContext {
    return { request, method, url, path, params, query: url.searchParams };
  }

  /** 返回 true 表示本次请求被 PIN 锁拦截。免锁端点不读 token。 */
  private async pinLocked(
    request: Request,
    method: string,
    path: string,
    gate: LocalApiGateState,
  ): Promise<boolean> {
    if (!gate.pinRequired) return false;
    if (PIN_EXEMPT_ENDPOINTS.has(`${method} ${path}`)) return false;

    const token = request.headers.get(PIN_TOKEN_HEADER);
    if (!token) return true;

    const validator = this.options.isPinTokenValid;
    if (!validator) return true;
    try {
      return (await validator(token)) !== true;
    } catch {
      return true;
    }
  }

  private async readGateState(): Promise<LocalApiGateState> {
    const reader = this.options.readGateState;
    if (!reader) return { pendingWipe: false, pinRequired: true };
    const state = await reader();
    return { pendingWipe: state.pendingWipe === true, pinRequired: state.pinRequired !== false };
  }
}

export function createLocalApiRouter(options: LocalApiRouterOptions = {}): LocalApiRouter {
  return new LocalApiRouter(options);
}

export interface LocalApiFetchOptions extends LocalApiRouterOptions {
  /** 判定同源所用的 origin；默认取 globalThis.location.origin。 */
  readonly origin?: string;
  /** 原生 fetch；默认 globalThis.fetch。 */
  readonly nativeFetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** 复用既有路由实例（例如 bootstrap 已注册业务处理器）。 */
  readonly router?: LocalApiRouter;
}

function currentOrigin(): string {
  const location = (globalThis as { location?: { origin?: string } }).location;
  return location?.origin && location.origin !== 'null' ? location.origin : DEFAULT_FETCH_ORIGIN;
}

function isRequestLike(value: unknown): value is Request {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Request).url === 'string' &&
    typeof (value as Request).method === 'string'
  );
}

function isLocalApiPath(pathname: string): boolean {
  const normalized =
    pathname.length > 1 && pathname.endsWith('/') ? pathname.replace(/\/+$/, '') : pathname;
  return normalized === LOCAL_API_PREFIX || normalized.startsWith(`${LOCAL_API_PREFIX}/`);
}

/**
 * 生成同源 fetch：只接管 `<origin>/api/v1/*`，其余请求原样传回原生 fetch
 * （不复制 input/init），保证外源调用语义不变。
 */
export function createLocalApiFetch(options: LocalApiFetchOptions = {}): typeof fetch {
  const router = options.router ?? new LocalApiRouter(options);
  const base = new URL(options.origin ?? currentOrigin());
  // 必须在创建时捕获原生实现：调用方随后会用它替换 globalThis.fetch。
  const nativeFetch = options.nativeFetch ?? globalThis.fetch.bind(globalThis);

  const localFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? new URL(input, base)
        : input instanceof URL
          ? new URL(input.href)
          : isRequestLike(input)
            ? new URL(input.url)
            : null;

    if (!url || url.origin !== base.origin || !isLocalApiPath(url.pathname)) {
      return nativeFetch(input, init);
    }

    const request = isRequestLike(input)
      ? init
        ? new Request(input, init)
        : input
      : new Request(url.href, init);
    return router.handle(request);
  };

  return localFetch as typeof fetch;
}

/** 429 helper：同时写 Retry-After 头与 error.details.retryAfter，供适配器读取。 */
export function pinAttemptsExceeded(retryAfterSeconds: number): LocalApiError {
  const seconds =
    Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds : 30;
  return new LocalApiError(429, 'PIN_ATTEMPTS_EXCEEDED', `尝试次数过多，请 ${seconds} 秒后再试`, {
    details: { retryAfter: seconds },
    headers: { 'retry-after': String(seconds) },
  });
}

/** 409 helper：版本冲突等并发写入失败。 */
export function conflictError(message: string, details?: Record<string, unknown>): LocalApiError {
  return new LocalApiError(409, 'CONFLICT', message, { details });
}
