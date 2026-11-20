import { describe, expect, it } from 'vitest';

import worker, { HouseholdHub, type Env } from '../src/index';

const env = {
  HOUSEHOLD_HUB: {} as Env['HOUSEHOLD_HUB'],
  PRIVATE_BUCKET: {} as Env['PRIVATE_BUCKET'],
};

function call(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`https://cloud.dafan.test${path}`, init), env);
}

describe('GET /api/cloud/health', () => {
  it('returns ok payload with binding status', async () => {
    const res = await call('/api/cloud/health');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    await expect(res.json()).resolves.toEqual({
      status: 'ok',
      service: 'cloud-worker',
      bindings: { householdHub: true, privateBucket: true },
    });
  });

  it('rejects non-GET methods with 405 and Allow header', async () => {
    const res = await call('/api/cloud/health', { method: 'POST' });

    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
    await expect(res.json()).resolves.toMatchObject({ error: 'method_not_allowed' });
  });
});

describe('unknown routes', () => {
  it('returns 404 JSON for an unknown path', async () => {
    const res = await call('/api/cloud/sync');

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: 'not_found' });
  });

  it('returns 404 JSON for an unknown method/path combination', async () => {
    const res = await call('/api/cloud/health/extra', { method: 'DELETE' });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: 'not_found' });
  });
});

describe('HouseholdHub', () => {
  it('exposes a stub fetch endpoint without business sync', async () => {
    const hub = new HouseholdHub({} as DurableObjectState, env);

    const res = await hub.fetch();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, object: 'household-hub' });
  });
});
