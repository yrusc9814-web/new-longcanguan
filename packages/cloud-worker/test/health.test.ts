import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import worker, { HouseholdHub, type Env } from '../src/index';

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url).href);

interface Harness {
  env: Env;
  /** 每次进入 DO stub 的原始 Request 对象。 */
  forwarded: Request[];
  /** 每次解析 DO 命名空间时收到的 name。 */
  names: string[];
  /** stub 固定返回的响应，便于断言外层没有改写它。 */
  response: Response;
}

function createHarness(): Harness {
  const forwarded: Request[] = [];
  const names: string[] = [];
  const response = new Response(JSON.stringify({ ok: true, at: 'stub' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  const stub = {
    fetch: async (request: Request): Promise<Response> => {
      forwarded.push(request);
      return response;
    },
  };

  const namespace = {
    idFromName(name: string) {
      names.push(name);
      return { name } as unknown as DurableObjectId;
    },
    get() {
      return stub;
    },
  };

  const env = {
    HOUSEHOLD_HUB: namespace,
    PRIVATE_BUCKET: {},
  };

  return { env: env as unknown as Env, forwarded, names, response };
}

function call(harness: Harness, path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`https://cloud.dafan.test${path}`, init), harness.env);
}

/**
 * 带内容的请求体。Node 的 Request 会在构造后预读首块做缓冲，
 * 因此不能用流 pull 次数判定"被消费"；以 bodyUsed 与字节完整性为准。
 */
function streamingBody(chunks: Uint8Array[]) {
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
    },
  });

  return stream;
}

const BODY_BYTES = [1, 2, 3, 250, 251];

function bodyRequest(url: string, method: string, headers: Record<string, string>) {
  const request = new Request(url, {
    method,
    headers,
    body: streamingBody([new Uint8Array(BODY_BYTES.slice(0, 3)), new Uint8Array([250, 251])]),
    duplex: 'half',
  } as RequestInit);

  return { request };
}

/** 外层若读过请求体，这里会失败或拿到残缺字节。 */
async function expectUntouchedBody(request: Request, expected = BODY_BYTES): Promise<void> {
  expect(request.bodyUsed).toBe(false);
  const received = new Uint8Array(await request.arrayBuffer());
  expect(Array.from(received)).toEqual(expected);
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[\s;{}()])\/\/[^\n]*/gm, '$1')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/**
 * 去掉继承 DurableObject 的类体：DO 内部按设计可以解析请求体，
 * 不属于外层 10ms CPU 预算的约束范围。按结构识别，不绑定类名。
 */
function stripDurableObjectClasses(source: string): string {
  let out = '';
  let cursor = 0;

  for (const match of source.matchAll(/class\s+\w+[^{;]*extends\s+DurableObject\b[\s\S]*?\{/g)) {
    const headerEnd = match.index + match[0].length;
    let depth = 1;
    let index = headerEnd;
    while (index < source.length && depth > 0) {
      const char = source[index];
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
      index += 1;
    }
    out += source.slice(cursor, match.index);
    cursor = index;
  }

  return out + source.slice(cursor);
}

const OUTER_BODY_ACCESS: ReadonlyArray<readonly [string, RegExp]> = [
  ['request.json()', /\b(?:request|req)\s*\.\s*json\s*\(/],
  ['request.text()', /\b(?:request|req)\s*\.\s*text\s*\(/],
  ['request.arrayBuffer()', /\b(?:request|req)\s*\.\s*arrayBuffer\s*\(/],
  ['request.bytes()', /\b(?:request|req)\s*\.\s*bytes\s*\(/],
  ['request.blob()', /\b(?:request|req)\s*\.\s*blob\s*\(/],
  ['request.formData()', /\b(?:request|req)\s*\.\s*formData\s*\(/],
  ['request.body.getReader()', /\b(?:request|req)\s*\.\s*body\s*\.\s*getReader\s*\(/],
  ['JSON.parse()', /\bJSON\s*\.\s*parse\s*\(/],
  ['crypto.subtle.digest', /\bcrypto\s*\.\s*subtle\s*\.\s*digest\b/],
  ['digest()', /(?<![\w.$])digest\s*\(/],
  ['sha256() helper', /\bsha256(?:Hex|Of|Digest|Base64)?\s*\(/i],
];

describe('GET /api/cloud/health', () => {
  it('returns ok payload with binding status', async () => {
    const res = await call(createHarness(), '/api/cloud/health');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    await expect(res.json()).resolves.toEqual({
      status: 'ok',
      service: 'cloud-worker',
      bindings: { householdHub: true, privateBucket: true },
    });
  });

  it('rejects non-GET methods with 405 and Allow header', async () => {
    const res = await call(createHarness(), '/api/cloud/health', { method: 'POST' });

    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
    await expect(res.json()).resolves.toMatchObject({ error: 'method_not_allowed' });
  });
});

describe('unknown routes', () => {
  it('returns 404 JSON for an unknown path', async () => {
    const harness = createHarness();
    const res = await call(harness, '/api/cloud/sync');

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: 'not_found' });
    expect(harness.forwarded).toHaveLength(0);
  });

  it('returns 404 JSON for an unknown method/path combination', async () => {
    const harness = createHarness();
    const res = await call(harness, '/api/cloud/health/extra', { method: 'DELETE' });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: 'not_found' });
    expect(harness.forwarded).toHaveLength(0);
  });
});

describe('gateway forwards /api/sync/* and /api/household/* to HouseholdHub', () => {
  it('hands the identical request to the stub and never consumes its body', async () => {
    const harness = createHarness();
    const { request } = bodyRequest(
      'https://cloud.dafan.test/api/sync/commands?since=7&limit=50',
      'POST',
      {
        'content-type': 'application/json',
        'x-household-token': 'token-1',
        'x-household-epoch': '3',
      },
    );

    const res = await worker.fetch(request, harness.env);

    expect(res.status).toBe(200);
    expect(harness.forwarded).toHaveLength(1);
    expect(harness.forwarded[0]).toBe(request);
    expect(harness.forwarded[0].url).toBe(
      'https://cloud.dafan.test/api/sync/commands?since=7&limit=50',
    );
    expect(harness.forwarded[0].method).toBe('POST');
    expect(harness.forwarded[0].headers.get('x-household-token')).toBe('token-1');
    expect(harness.forwarded[0].headers.get('x-household-epoch')).toBe('3');
    expect(harness.names).toEqual(['default']);
    await expectUntouchedBody(harness.forwarded[0]);
  });

  it.each(['GET', 'POST', 'PUT', 'DELETE'])(
    'accepts %s on /api/sync/* and forwards it unchanged',
    async (method) => {
      const harness = createHarness();
      const chunks = [new Uint8Array([4, 5, 6])];
      const request = new Request('https://cloud.dafan.test/api/sync/state?cursor=9', {
        method,
        headers: { 'x-household-token': 'token-1' },
        ...(method === 'GET' ? {} : { body: streamingBody(chunks), duplex: 'half' }),
      } as RequestInit);

      const res = await worker.fetch(request, harness.env);

      expect(res.status).toBe(200);
      expect(harness.forwarded).toHaveLength(1);
      expect(harness.forwarded[0]).toBe(request);
      expect(harness.forwarded[0].method).toBe(method);
      expect(harness.names).toEqual(['default']);
      if (method !== 'GET') {
        await expectUntouchedBody(harness.forwarded[0], [4, 5, 6]);
      }
    },
  );

  it.each(['GET', 'POST', 'PUT', 'DELETE'])(
    'accepts %s on /api/household/* and forwards it unchanged',
    async (method) => {
      const harness = createHarness();
      const chunks = [new Uint8Array([9, 8, 7])];
      const request = new Request('https://cloud.dafan.test/api/household/members?force=1', {
        method,
        headers: { 'x-household-token': 'token-2', 'content-type': 'application/json' },
        ...(method === 'GET' ? {} : { body: streamingBody(chunks), duplex: 'half' }),
      } as RequestInit);

      const res = await worker.fetch(request, harness.env);

      expect(res.status).toBe(200);
      expect(harness.forwarded).toHaveLength(1);
      expect(harness.forwarded[0]).toBe(request);
      expect(harness.forwarded[0].url).toBe(
        'https://cloud.dafan.test/api/household/members?force=1',
      );
      expect(harness.names).toEqual(['default']);
      if (method !== 'GET') {
        await expectUntouchedBody(harness.forwarded[0], [9, 8, 7]);
      }
    },
  );

  it('passes the stub response through without rewriting it', async () => {
    const harness = createHarness();
    const request = new Request('https://cloud.dafan.test/api/household/meta', {
      method: 'GET',
      headers: { 'x-household-token': 'token-3' },
    });

    const res = await worker.fetch(request, harness.env);

    expect(res.status).toBe(harness.response.status);
    expect(res.headers.get('content-type')).toBe(harness.response.headers.get('content-type'));
    await expect(res.json()).resolves.toEqual({ ok: true, at: 'stub' });
  });
});

describe('image and WebSocket routes', () => {
  it.each([
    ['PUT', '/api/sync/images/abc?variant=thumb'],
    ['PATCH', '/api/sync/images'],
  ])('leaves %s %s for the household to handle', async (method, path) => {
    const harness = createHarness();
    const { request } = bodyRequest(`https://cloud.dafan.test${path}`, method, {});

    expect(await worker.fetch(request, harness.env)).toBe(harness.response);
    expect(harness.forwarded[0]).toBe(request);
    await expectUntouchedBody(request);
  });

  it('forwards the original WebSocket upgrade and its ticket query', async () => {
    const harness = createHarness();
    const request = new Request('https://cloud.dafan.test/api/sync/ws?ticket=fixture', {
      headers: { upgrade: 'websocket' },
    });

    expect(await worker.fetch(request, harness.env)).toBe(harness.response);
    expect(harness.forwarded[0]).toBe(request);
  });
});

describe('outer Worker stays CPU-cheap (static)', () => {
  it('src/index.ts never parses bodies or hashes image bytes', () => {
    const outer = stripComments(
      stripDurableObjectClasses(readFileSync(join(SRC_DIR, 'index.ts'), 'utf8')),
    );
    const violations = OUTER_BODY_ACCESS.filter(([, pattern]) => pattern.test(outer)).map(
      ([label]) => label,
    );

    expect(violations, 'index.ts must stay a streaming proxy').toEqual([]);
  });

  it('src/image-proxy.ts streams image bytes without buffering or hashing them in JavaScript', () => {
    const outer = stripComments(
      stripDurableObjectClasses(readFileSync(join(SRC_DIR, 'image-proxy.ts'), 'utf8')),
    );
    const violations = OUTER_BODY_ACCESS.filter(([, pattern]) => pattern.test(outer)).map(
      ([label]) => label,
    );

    expect(violations, 'image-proxy.ts must stream image bytes to R2').toEqual([]);
  });

  it('keeps the default worker, named Env and HouseholdHub exports', () => {
    const source = stripComments(readFileSync(join(SRC_DIR, 'index.ts'), 'utf8'));

    expect(source).toMatch(/export\s+default\b/);
    expect(typeof worker.fetch).toBe('function');
    expect(source).toMatch(/export\s+(?:interface|type)\s+Env\b/);
    // HouseholdHub 允许从 index.ts 直接声明或转发导出，二者都算仍对外导出。
    expect(source).toMatch(
      /export\s+(?:class|declare class)\s+HouseholdHub\b|export\s*\{[^}]*\bHouseholdHub\b/,
    );
    expect(typeof HouseholdHub).toBe('function');
  });
});
