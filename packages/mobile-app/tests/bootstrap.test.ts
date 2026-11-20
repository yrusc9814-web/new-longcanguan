import { afterEach, expect, it, vi } from 'vitest';

const { openDatabase, query } = vi.hoisted(() => {
  const query = vi.fn(async () => [{ ready: 1 }]);
  return { query, openDatabase: vi.fn(async () => ({ query })) };
});

vi.mock('../src/db/index.js', () => ({ openCapacitorDatabase: openDatabase }));
vi.mock('@capacitor-community/sqlite', () => ({ CapacitorSQLite: {} }));
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'android' },
  registerPlugin: () => ({
    getGateState: async () => ({
      lockedPendingWipe: false,
      pinRequired: false,
      pinUnlocked: false,
    }),
    setGateState: async () => ({
      lockedPendingWipe: false,
      pinRequired: false,
      pinUnlocked: false,
    }),
  }),
}));

afterEach(() => vi.unstubAllGlobals());

it('启动即拦截 Google2 的首个同源 API 请求，并在健康探针中查询 SQLite', async () => {
  const originalFetch = vi.fn(async () => new Response('cloud'));
  vi.stubGlobal('fetch', originalFetch);
  vi.stubGlobal('location', new URL('https://localhost/'));
  await import('../src/local-api/bootstrap.js');

  const health = await fetch('/api/v1/health');
  expect(health.status).toBe(200);
  await expect(health.json()).resolves.toMatchObject({
    success: true,
    data: { database: { status: 'ok', provider: 'sqlite' } },
  });
  expect(openDatabase).toHaveBeenCalledTimes(1);
  expect(query).toHaveBeenCalledWith('SELECT 1 AS ready');

  const input = new URL('https://cloud.example/api/v1/health');
  const options = { method: 'POST' };
  await expect((await fetch(input, options)).text()).resolves.toBe('cloud');
  expect(originalFetch).toHaveBeenCalledExactlyOnceWith(input, options);
});
