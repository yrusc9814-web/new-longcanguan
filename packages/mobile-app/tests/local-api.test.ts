import { describe, expect, it, vi } from 'vitest';
import { RETIRED_ENDPOINTS } from '@dafan/shared/contracts';
import { VersionConflictError } from '../src/db/errors.js';

import {
  blobResult,
  conflictError,
  createLocalApiFetch,
  createLocalApiRouter,
  dataResult,
  LocalApiRouter,
  pinAttemptsExceeded,
  readFormDataBody,
  readJsonBody,
  type LocalApiGateState,
} from '../src/local-api/index.js';
import {
  ADAPTER_PIN_KEY,
  loadGoogle2Adapter,
  type AdapterApiError,
} from './local-api-adapter-harness.js';

const ORIGIN = 'http://localhost';
const VALID_TOKEN = 'pin-token-ok';

interface HarnessOptions {
  readonly gate?: LocalApiGateState;
  readonly validTokens?: readonly string[];
  readonly register?: (router: LocalApiRouter) => void;
  readonly healthDatabaseProbe?: () => { status: 'ok' | 'error' };
  readonly nativeFetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly pinToken?: string | null;
}

/** 构建「真实 adapter + 本地路由 fetch」组合，并预置 PIN token。 */
function createHarness(options: HarnessOptions = {}) {
  const gate: LocalApiGateState = options.gate ?? { pendingWipe: false, pinRequired: true };
  const validTokens = new Set(options.validTokens ?? [VALID_TOKEN]);
  const router = createLocalApiRouter({
    readGateState: () => gate,
    isPinTokenValid: (token) => validTokens.has(token),
    healthDatabaseProbe: options.healthDatabaseProbe,
    now: () => new Date('2026-01-02T03:04:05.000Z'),
  });
  options.register?.(router);

  const localFetch = createLocalApiFetch({
    router,
    origin: ORIGIN,
    nativeFetch: options.nativeFetch,
  });
  const adapter = loadGoogle2Adapter({ fetch: localFetch, origin: ORIGIN });
  if (options.pinToken !== null) {
    adapter.storage.set(ADAPTER_PIN_KEY, options.pinToken ?? VALID_TOKEN);
  }
  return { adapter, router, localFetch };
}

function routePath(path: string): string {
  // adapter 内部会补 API_BASE 前缀，这里喂给 adapter 的是相对路径。
  return path.replace(/^\/api\/v1/, '').replace(/:[a-zA-Z]+/g, 'sample-id');
}

async function expectApiError(promise: Promise<unknown>): Promise<AdapterApiError> {
  try {
    await promise;
  } catch (error) {
    return error as AdapterApiError;
  }
  throw new Error('预期请求失败，但返回了成功响应');
}

describe('GET /api/v1/health（真实 adapter 请求真实路由）', () => {
  it('返回 success/data/error 信封与共享 HealthData 契约', async () => {
    const { adapter, localFetch } = createHarness({
      healthDatabaseProbe: () => ({ status: 'ok' }),
    });

    const data = await adapter.api.get<Record<string, unknown>>('/health');

    expect(data).toEqual({
      status: 'ok',
      app: '搭饭小馆',
      version: '0.1.0',
      database: { status: 'ok', provider: 'sqlite' },
      timestamp: '2026-01-02T03:04:05.000Z',
    });

    const raw = await localFetch(`${ORIGIN}/api/v1/health`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get('content-type')).toBe('application/json; charset=utf-8');
    await expect(raw.json()).resolves.toMatchObject({ success: true, error: null });
  });

  it('数据库探针失败或抛错时返回上游约定的 503 DATABASE_ERROR', async () => {
    const failing = createHarness({ healthDatabaseProbe: () => ({ status: 'error' }) });
    const throwing = createHarness({
      healthDatabaseProbe: () => {
        throw new Error('probe boom');
      },
    });
    for (const { adapter } of [failing, throwing]) {
      await expect(adapter.api.get('/health')).rejects.toMatchObject({
        status: 503,
        code: 'DATABASE_ERROR',
      });
    }
  });

  it('未注入探针时返回 503 DATABASE_ERROR', async () => {
    const { adapter } = createHarness();
    await expect(adapter.api.get('/health')).rejects.toMatchObject({
      status: 503,
      code: 'DATABASE_ERROR',
    });
  });

  it('pinRequired 下仍免锁，且忽略无效 token', async () => {
    const { adapter, localFetch } = createHarness({
      pinToken: 'bogus',
      healthDatabaseProbe: () => ({ status: 'ok' }),
    });
    const response = await localFetch(`${ORIGIN}/api/v1/health`, {
      headers: { 'x-app-pin-token': 'bogus' },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, error: null });
    await expect(adapter.api.get('/health')).resolves.toMatchObject({ status: 'ok' });
  });
});

describe('同源拦截与外源透传', () => {
  it('外源请求把原始 input/init 交给 native fetch，不做任何改写', async () => {
    const seen: Array<[unknown, unknown]> = [];
    const nativeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push([input, init]);
      return new Response('upstream-body', { status: 201 });
    };
    const { localFetch } = createHarness({ nativeFetch });

    const init: RequestInit = { method: 'POST', headers: { 'x-custom': '1' }, body: 'raw' };
    const response = await localFetch('https://example.com/graphql', init);

    expect(response.status).toBe(201);
    await expect(response.text()).resolves.toBe('upstream-body');
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toBe('https://example.com/graphql');
    expect(seen[0][1]).toBe(init);
  });

  it('别的路径前缀 / 非同源 /api/v1 均不拦截', async () => {
    const seen: unknown[] = [];
    const nativeFetch = async (input: RequestInfo | URL) => {
      seen.push(input);
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    };
    const { localFetch } = createHarness({ nativeFetch });

    await localFetch(`${ORIGIN}/api/v2/health`);
    await localFetch(`${ORIGIN}/uploads/images/x.png`);
    await localFetch('https://cdn.example.com/api/v1/health');

    expect(seen).toEqual([
      `${ORIGIN}/api/v2/health`,
      `${ORIGIN}/uploads/images/x.png`,
      'https://cdn.example.com/api/v1/health',
    ]);
  });

  it('相对路径 /api/v1 按同源处理，跨源 Request 对象原样透传', async () => {
    const seen: unknown[] = [];
    const nativeFetch = async (input: RequestInfo | URL) => {
      seen.push(input);
      return new Response('external');
    };
    const { localFetch } = createHarness({
      nativeFetch,
      healthDatabaseProbe: () => ({ status: 'ok' }),
    });

    const external = new Request('https://example.com/api/v1/health');
    const response = await localFetch(external);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('external');
    expect(seen[0]).toBe(external);

    const local = await localFetch('/api/v1/health');
    expect(local.status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it('未注入 nativeFetch 时在创建期捕获全局 fetch，替换后不会自递归', async () => {
    const originalFetch = vi.fn(async () => new Response('cloud', { status: 200 }));
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    try {
      vi.stubGlobal('fetch', originalFetch);
      const router = createLocalApiRouter({
        readGateState: () => ({ pendingWipe: false, pinRequired: false }),
      });
      // 模拟 bootstrap：替换全局 fetch 之前先创建包装器。
      const localFetch = createLocalApiFetch({ router, origin: ORIGIN });
      vi.stubGlobal('fetch', localFetch);

      const result = await localFetch('https://cloud.example/api/v1/health');
      await expect(result.text()).resolves.toBe('cloud');
      expect(originalFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      if (descriptor) Object.defineProperty(globalThis, 'fetch', descriptor);
    }
  });
});

describe('原生 Request 载体：JSON / FormData / Blob / query', () => {
  it('JSON 请求体与 query 参数经原生 API 读取', async () => {
    const { adapter } = createHarness({
      register: (router) => {
        router.register('POST', '/api/v1/records', async ({ request, query }) => {
          const body = await readJsonBody<{ note: string }>(request);
          return { note: body.note, page: query.get('page'), active: query.get('active') };
        });
      },
    });

    await expect(
      adapter.api.post('/records?page=2&active=true', { note: '晚饭' }),
    ).resolves.toEqual({ note: '晚饭', page: '2', active: 'true' });
  });

  it('非法 JSON 返回 400 VALIDATION_ERROR', async () => {
    const { adapter } = createHarness({
      register: (router) => {
        router.register('POST', '/api/v1/records', ({ request }) => readJsonBody(request));
      },
    });

    const error = await expectApiError(
      adapter.api.request('/records', {
        method: 'POST',
        body: '{oops',
        _skipPinRetry: true,
      }),
    );
    expect(error.status).toBe(400);
    expect(error.code).toBe('VALIDATION_ERROR');
  });

  it('multipart FormData 走原生 request.formData()', async () => {
    const { adapter } = createHarness({
      register: (router) => {
        router.register('POST', '/api/v1/uploads/images', async ({ request }) => {
          const form = await readFormDataBody(request);
          const file = form.get('file') as File;
          return {
            url: `/uploads/images/${file.name}`,
            name: file.name,
            type: file.type,
            size: file.size,
            contentType: request.headers.get('content-type'),
          };
        });
      },
    });

    const form = new FormData();
    form.append('file', new Blob(['ab'], { type: 'image/png' }), 'cover.png');

    const result = await adapter.api.request<Record<string, unknown>>('/uploads/images', {
      method: 'POST',
      body: form,
    });
    expect(result).toMatchObject({
      url: '/uploads/images/cover.png',
      name: 'cover.png',
      type: 'image/png',
      size: 2,
    });
    // 适配器不得给 FormData 强加 application/json。
    expect(String(result.contentType)).toMatch(/^multipart\/form-data; boundary=/);
  });

  it('requestBlob 拿到二进制与响应头（备份导出）', async () => {
    const { adapter } = createHarness({
      register: (router) => {
        router.register('GET', '/api/v1/backups/export', () =>
          blobResult(new Blob(['zip-bytes'], { type: 'application/zip' }), {
            headers: { 'content-disposition': 'attachment; filename="backup.zip"' },
          }),
        );
      },
    });

    const blob = await adapter.api.requestBlob('/backups/export');
    expect(blob.type).toBe('application/zip');
    await expect(blob.text()).resolves.toBe('zip-bytes');
  });

  it('处理器可用 dataResult 指定状态码与响应头', async () => {
    const { adapter } = createHarness({
      register: (router) => {
        router.register('DELETE', '/api/v1/records/:id', ({ params }) =>
          dataResult({ deleted: params.id }, { status: 202, headers: { 'x-trace': 'abc' } }),
        );
      },
    });

    await expect(adapter.api.request('/records/r%201', { method: 'DELETE' })).resolves.toEqual({
      deleted: 'r 1',
    });
  });
});

describe('错误信封：409 / 429 Retry-After / 500', () => {
  it('409 冲突带 code/message/details', async () => {
    const { adapter } = createHarness({
      register: (router) => {
        router.register('PUT', '/api/v1/records/:id', () => {
          throw conflictError('版本冲突', { expectedVersion: 2, actualVersion: 3 });
        });
      },
    });

    const error = await expectApiError(adapter.api.put('/records/abc', { version: 2 }));
    expect(error.status).toBe(409);
    expect(error.code).toBe('CONFLICT');
    expect(error.details).toEqual({ expectedVersion: 2, actualVersion: 3 });
  });

  it('将 SQLite 乐观锁冲突转为适配器可识别的 409 VERSION_CONFLICT', async () => {
    const { adapter } = createHarness({
      register(router) {
        router.register('PUT', '/api/v1/records/:id', ({ params }) => {
          throw new VersionConflictError('MealRecord', params.id, 2, 3);
        });
      },
    });

    await expect(adapter.api.put('/records/abc', { version: 2 })).rejects.toMatchObject({
      status: 409,
      code: 'VERSION_CONFLICT',
      details: { entity: 'MealRecord', id: 'abc', expectedVersion: 2, actualVersion: 3 },
    });
  });

  it('429 同时带 Retry-After 头与 details.retryAfter，adapter 两处都能读到', async () => {
    const { adapter, localFetch } = createHarness({
      register: (router) => {
        router.register('POST', '/api/v1/settings/pin/verify', () => {
          throw pinAttemptsExceeded(42);
        });
      },
    });

    const error = await expectApiError(adapter.api.post('/settings/pin/verify', { pin: '0000' }));
    expect(error.status).toBe(429);
    expect(error.code).toBe('PIN_ATTEMPTS_EXCEEDED');
    expect(error.retryAfter).toBe(42);
    expect(error.details).toEqual({ retryAfter: 42 });

    const raw = await localFetch(`${ORIGIN}/api/v1/settings/pin/verify`, {
      method: 'POST',
      body: JSON.stringify({ pin: '0000' }),
    });
    expect(raw.status).toBe(429);
    expect(raw.headers.get('retry-after')).toBe('42');
    await expect(raw.json()).resolves.toMatchObject({
      success: false,
      data: null,
      error: { code: 'PIN_ATTEMPTS_EXCEEDED', details: { retryAfter: 42 } },
    });
  });

  it('未捕获异常变成 500 INTERNAL_ERROR，不泄露堆栈', async () => {
    const { adapter } = createHarness({
      register: (router) => {
        router.register('GET', '/api/v1/dashboard', () => {
          throw new Error('db exploded at secret/path.ts:9');
        });
      },
    });

    const error = await expectApiError(adapter.api.get('/dashboard'));
    expect(error.status).toBe(500);
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.message).not.toContain('secret/path');
  });
});

describe('PIN 守卫', () => {
  it('有效 token 放行并把 X-App-Pin-Token 传给处理器', async () => {
    const { adapter } = createHarness({
      register: (router) => {
        router.register('GET', '/api/v1/recipes', ({ request }) => ({
          token: request.headers.get('x-app-pin-token'),
        }));
      },
    });
    await expect(adapter.api.get('/recipes')).resolves.toEqual({ token: VALID_TOKEN });
  });

  it('缺 token 或 token 无效返回 401 UNAUTHORIZED', async () => {
    const noToken = createHarness({
      pinToken: null,
      register: (router) => {
        router.register('GET', '/api/v1/recipes', () => []);
      },
    });
    const missing = await expectApiError(
      noToken.adapter.api.request('/recipes', { _skipPinRetry: true }),
    );
    expect(missing.status).toBe(401);
    expect(missing.code).toBe('UNAUTHORIZED');

    const badToken = createHarness({
      pinToken: 'bogus',
      register: (router) => {
        router.register('GET', '/api/v1/recipes', () => []);
      },
    });
    const invalid = await expectApiError(
      badToken.adapter.api.request('/recipes', { _skipPinRetry: true }),
    );
    expect(invalid.status).toBe(401);
    expect(invalid.code).toBe('UNAUTHORIZED');
  });

  it('pinRequired=false 时不要求 token；校验器抛错按 fail closed 处理', async () => {
    const unlocked = createHarness({
      gate: { pendingWipe: false, pinRequired: false },
      pinToken: null,
      register: (router) => router.register('GET', '/api/v1/recipes', () => []),
    });
    await expect(unlocked.adapter.api.get('/recipes')).resolves.toEqual([]);

    const router = createLocalApiRouter({
      readGateState: () => ({ pendingWipe: false, pinRequired: true }),
      isPinTokenValid: () => {
        throw new Error('native pin store unavailable');
      },
    });
    router.register('GET', '/api/v1/recipes', () => []);
    const response = await router.handle(
      new Request(`${ORIGIN}/api/v1/recipes`, { headers: { 'x-app-pin-token': VALID_TOKEN } }),
    );
    expect(response.status).toBe(401);
  });

  it('未注入 readGateState/isPinTokenValid 时默认 fail closed', async () => {
    const router = createLocalApiRouter({ healthDatabaseProbe: () => ({ status: 'ok' }) });
    router.register('GET', '/api/v1/recipes', () => []);

    const withToken = await router.handle(
      new Request(`${ORIGIN}/api/v1/recipes`, { headers: { 'x-app-pin-token': VALID_TOKEN } }),
    );
    expect(withToken.status).toBe(401);

    const health = await router.handle(new Request(`${ORIGIN}/api/v1/health`));
    expect(health.status).toBe(200);
  });

  it('适配器真实重试分支：401 触发 PIN 解锁，免重试端点直接抛 401', async () => {
    const { adapter } = createHarness({
      pinToken: null,
      register: (router) => {
        router.register('GET', '/api/v1/recipes', () => []);
        router.register('PUT', '/api/v1/settings/pin', () => ({ updated: true }));
      },
    });

    // harness 无 PIN 弹窗元素 → ensurePinUnlock 以 PIN_UNLOCK_CANCELLED 失败，
    // 说明请求确实经过 adapter 的 401 → ensurePinUnlock → 重试链路。
    const retried = await expectApiError(adapter.api.get('/recipes'));
    expect(retried.status).toBe(401);
    expect(retried.code).toBe('PIN_UNLOCK_CANCELLED');

    // PIN_RETRY_EXCLUDED 中的端点不进入解锁流程。
    const excluded = await expectApiError(adapter.api.put('/settings/pin', { pin: '1234' }));
    expect(excluded.status).toBe(401);
    expect(excluded.code).toBe('UNAUTHORIZED');
  });

  it('恢复授权和恢复可在 PIN 已锁定时进入业务验证，PUT /settings/pin 仍需 token', async () => {
    const register = (router: LocalApiRouter) => {
      router.register('GET', '/api/v1/settings', () => ({ pinEnabled: true }));
      router.register('GET', '/api/v1/settings/pin/session', () => ({ required: true }));
      router.register('POST', '/api/v1/settings/pin/verify', () => ({ valid: false }));
      router.register('PUT', '/api/v1/settings/pin', () => ({ updated: true }));
    };
    const unlockedHarness = createHarness({ register });
    for (const [path, init] of [
      ['/settings', undefined],
      ['/settings/pin/session', undefined],
      ['/settings/pin/verify', { method: 'POST', body: JSON.stringify({ pin: '1234' }) }],
    ] as const) {
      await expect(
        unlockedHarness.adapter.api.request(path, { ...(init ?? {}), _skipPinRetry: true }),
      ).resolves.toBeDefined();
    }

    const lockedHarness = createHarness({ register, pinToken: null });
    const locked = await expectApiError(
      lockedHarness.adapter.api.request('/settings/pin', {
        method: 'PUT',
        body: JSON.stringify({ pin: '1234' }),
        _skipPinRetry: true,
      }),
    );
    expect(locked.status).toBe(401);
    expect(locked.code).toBe('UNAUTHORIZED');
  });
});

describe('待清空守卫（MEMBER_REVOKED）', () => {
  it('pendingWipe 优先于 PIN：携带有效 token 也返回 403', async () => {
    const { adapter } = createHarness({
      gate: { pendingWipe: true, pinRequired: true },
      register: (router) => router.register('GET', '/api/v1/recipes', () => []),
    });

    const error = await expectApiError(adapter.api.request('/recipes', { _skipPinRetry: true }));
    expect(error.status).toBe(403);
    expect(error.code).toBe('MEMBER_REVOKED');
  });

  it('pendingWipe 优先于免锁端点与退役端点', async () => {
    const { router } = createHarness({ gate: { pendingWipe: true, pinRequired: true } });

    for (const [method, path] of [
      ['GET', '/api/v1/health'],
      ['GET', '/api/v1/settings'],
      ['GET', '/api/v1/calendar'],
    ] as const) {
      const response = await router.handle(new Request(`${ORIGIN}${path}`, { method }));
      expect(response.status, `${method} ${path}`).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        success: false,
        error: { code: 'MEMBER_REVOKED' },
      });
    }
  });

  it('pinRequired=false 但 pendingWipe=true 仍拒绝', async () => {
    const { router } = createHarness({ gate: { pendingWipe: true, pinRequired: false } });
    const response = await router.handle(new Request(`${ORIGIN}/api/v1/health`));
    expect(response.status).toBe(403);
  });
});

describe('退役端点固定 404', () => {
  it('共享契约中的 30 条退役端点全部返回 404（含动态 id）', async () => {
    expect(RETIRED_ENDPOINTS).toHaveLength(30);
    const { adapter } = createHarness();

    for (const { method, path } of RETIRED_ENDPOINTS) {
      const error = await expectApiError(
        adapter.api.request(routePath(path), { method, _skipPinRetry: true }),
      );
      expect(error.status, `${method} ${path}`).toBe(404);
      expect(error.code, `${method} ${path}`).toBe('NOT_FOUND');
    }
  });

  it('PIN 守卫先于退役端点匹配', async () => {
    const { router } = createHarness({ pinToken: null });
    const response = await router.handle(new Request(`${ORIGIN}/api/v1/calendar`));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  it('退役端点优先于同路径已注册业务处理器', async () => {
    const { router } = createHarness({
      gate: { pendingWipe: false, pinRequired: false },
      register: (r) => r.register('GET', '/api/v1/calendar', () => ({ should: 'not run' })),
    });
    const response = await router.handle(new Request(`${ORIGIN}/api/v1/calendar`));
    expect(response.status).toBe(404);
  });
});

describe('路由注册与保留端点边界', () => {
  it('默认仅注册 health，其余保留端点返回 501 NOT_IMPLEMENTED', async () => {
    const { adapter } = createHarness();
    const error = await expectApiError(adapter.api.get('/recipes'));
    expect(error.status).toBe(501);
    expect(error.code).toBe('NOT_IMPLEMENTED');
  });

  it('免锁端点业务未接通时同样 501，且不因无 token 变 401', async () => {
    const { adapter } = createHarness({ pinToken: null });
    for (const [path, options] of [
      ['/settings', { _skipPinRetry: true }],
      ['/settings/pin/session', { _skipPinRetry: true }],
      [
        '/settings/pin/verify',
        { method: 'POST', body: JSON.stringify({ pin: '1234' }), _skipPinRetry: true },
      ],
    ] as const) {
      const error = await expectApiError(adapter.api.request(path, options));
      expect(error.status, path).toBe(501);
      expect(error.code, path).toBe('NOT_IMPLEMENTED');
    }
  });

  it('尾斜杠规范化后仍命中同一路由与免锁白名单', async () => {
    const { router } = createHarness({
      pinToken: null,
      healthDatabaseProbe: () => ({ status: 'ok' }),
    });
    const response = await router.handle(new Request(`${ORIGIN}/api/v1/health/`));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true });

    const status = await router.handle(new Request(`${ORIGIN}/api/v1/settings/`));
    expect(status.status).toBe(501);
  });

  it('未知路径 404，错误方法 405，重复注册报错', async () => {
    const { adapter, router } = createHarness();

    const unknown = await expectApiError(adapter.api.request('/nope', { _skipPinRetry: true }));
    expect(unknown.status).toBe(404);
    expect(unknown.code).toBe('NOT_FOUND');

    const wrongMethod = await expectApiError(
      adapter.api.request('/health', { method: 'DELETE', _skipPinRetry: true }),
    );
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.code).toBe('METHOD_NOT_ALLOWED');

    expect(() => router.register('GET', '/api/v1/health', () => null)).toThrow(/重复注册/);
    expect(() => router.register('GET', '/api/v2/health', () => null)).toThrow(/\/api\/v1/);
  });

  it('静态段优先于动态段，路径参数已解码', async () => {
    const { router } = createHarness({
      register: (r) => {
        r.register('GET', '/api/v1/stores/:id', ({ params }) =>
          dataResult({ kind: 'id', id: params.id }),
        );
        r.register('GET', '/api/v1/stores/featured', () => dataResult({ kind: 'featured' }));
      },
    });
    const pin = { 'x-app-pin-token': VALID_TOKEN };

    const featured = await router.handle(
      new Request(`${ORIGIN}/api/v1/stores/featured`, { headers: pin }),
    );
    await expect(featured.json()).resolves.toMatchObject({ data: { kind: 'featured' } });

    const byId = await router.handle(
      new Request(`${ORIGIN}/api/v1/stores/s%201`, { headers: pin }),
    );
    await expect(byId.json()).resolves.toMatchObject({ data: { kind: 'id', id: 's 1' } });
  });

  it('注册的业务 handler 收到统一 context（method/path/query/params）', async () => {
    const seen: unknown[] = [];
    const { localFetch } = createHarness({
      register: (r) =>
        r.register('DELETE', '/api/v1/recipes/:id', (context) => {
          seen.push({
            method: context.method,
            path: context.path,
            id: context.params.id,
            version: context.query.get('version'),
          });
          return null;
        }),
    });

    const response = await localFetch(`${ORIGIN}/api/v1/recipes/abc?version=3`, {
      method: 'DELETE',
      headers: { 'x-app-pin-token': VALID_TOKEN },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, data: null, error: null });
    expect(seen).toEqual([
      { method: 'DELETE', path: '/api/v1/recipes/abc', id: 'abc', version: '3' },
    ]);
  });
});
