import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { BUSINESS_INDEX_DDL, BUSINESS_TABLE_DDL, RETAINED_MODELS } from '@dafan/shared/contracts';
import {
  HOUSEHOLD_EPOCH_HEADER,
  IMAGE_CONTENT_SHA256_HEADER,
  IMAGE_MIME_TYPE,
  MAX_IMAGE_BYTES,
} from '@dafan/shared/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startWorkerd, type WorkerdHarness } from './run-workerd';

const origin = 'https://cloud.dafan.test';
const memberToken = 'fixture-member';
const ownerToken = 'fixture-owner';
const revokedToken = 'fixture-revoked';

const controlTables = [
  'household_meta',
  'household_members',
  'household_invites',
  'household_auth_attempts',
  'ws_tickets',
  'sync_log',
  'executed_operations',
  'image_objects',
];

type SchemaRow = { type: 'table' | 'index'; name: string; tbl_name: string; sql: string };
type ImageRow = {
  asset_sha256: string;
  variant: string;
  object_key: string;
  content_sha256: string;
  mime_type: string;
  size_bytes: number;
  epoch: number;
  uploaded_by: string;
};
interface DatabaseSnapshot {
  schema: SchemaRow[];
  logIndexes: { name: string }[];
  operationKey: { name: string }[];
  household: { id: number; household_id: string; epoch: number; initialized: number };
  settings: { id: number; version: number };
  shopping: { id: string; name: string; status: string; version: number }[];
  images: ImageRow[];
}

let runtime: WorkerdHarness;

function call(path: string, init?: RequestInit): Promise<Response> {
  return runtime.dispatchFetch(`${origin}${path}`, init);
}

function digest(body: Uint8Array | string): string {
  return createHash('sha256').update(body).digest('hex');
}

function bytes(label: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(`RIFF\0WEBP\0${label}`));
}

function auth(token = memberToken): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function seed(id: string, raw: string, status = 'ACTIVE', role = 'MEMBER'): Promise<void> {
  const response = await call('/__test/seed', {
    method: 'POST',
    body: JSON.stringify({ id, tokenHash: digest(raw), role, status }),
  });
  expect(response.status).toBe(204);
}

async function inspect(): Promise<DatabaseSnapshot> {
  const response = await call('/__test/inspect');
  expect(response.status).toBe(200);
  return response.json();
}

async function expectCode(response: Response, status: number, code: string): Promise<void> {
  const body = await response.json();
  expect(
    response.status,
    `${response.status} ${response.statusText}: ${JSON.stringify(body)}`,
  ).toBe(status);
  if (code === 'MEMBER_REVOKED') {
    // 撤权失败必须锚定到具体家庭与成员，客户端据此清理本地数据。
    expect(body).toEqual({ code, householdId: 'default', memberId: expect.any(String) });
    return;
  }
  expect(body).toEqual({ code });
}

function upload(
  body: Uint8Array<ArrayBuffer>,
  path = `/api/sync/images/${digest(body)}`,
  headers: Record<string, string> = {},
  token = memberToken,
): Promise<Response> {
  return call(path, {
    method: 'PUT',
    headers: {
      ...auth(token),
      'content-type': IMAGE_MIME_TYPE,
      'content-length': String(body.length),
      [HOUSEHOLD_EPOCH_HEADER]: '1',
      ...headers,
    },
    body,
  });
}

async function imageState() {
  const bucket = await runtime.getR2Bucket();
  const [listed, db] = await Promise.all([bucket.list(), inspect()]);
  return { bucketKeys: listed.objects.map(({ key }) => key).sort(), images: db.images };
}

beforeAll(async () => {
  runtime = await startWorkerd(new URL('./workerd-entry.ts', import.meta.url));
  await seed('member', memberToken);
  await seed('owner', ownerToken, 'ACTIVE', 'OWNER');
  await seed('revoked', revokedToken, 'REVOKED');
}, 30_000);

afterAll(async () => {
  await runtime?.dispose();
});

describe('HouseholdHub SQLite on workerd', () => {
  it('creates exactly the shared business schema and six controls, including composite keys', async () => {
    const { schema, logIndexes, operationKey, household, settings, shopping } = await inspect();
    expect(schema.filter(({ type }) => type === 'table').map(({ name }) => name)).toEqual(
      [...RETAINED_MODELS, ...controlTables].sort(),
    );

    const business = new Set<string>(RETAINED_MODELS);
    const appliedDdl = schema
      .filter(({ tbl_name }) => business.has(tbl_name))
      .map(({ sql }) => sql);
    const sharedDdl = [...BUSINESS_TABLE_DDL, ...BUSINESS_INDEX_DDL].map((sql) =>
      sql.replace(/^(CREATE (?:TABLE|(?:UNIQUE )?INDEX)) IF NOT EXISTS /, '$1 '),
    );
    expect(appliedDdl.sort()).toEqual(sharedDdl.sort());
    expect(
      schema.find(({ name }) => name === 'MealPlan_planDate_mealType_active_idx')?.sql,
    ).toMatch(/WHERE "deletedAt" IS NULL$/);
    expect(schema.find(({ name }) => name === 'MealRecord')?.sql).toContain(
      '"planUncompleteProof"',
    );
    expect(logIndexes.map(({ name }) => name)).toContain('sync_log_epoch_sync_seq_idx');
    expect(schema.find(({ name }) => name === 'sync_log_epoch_sync_seq_idx')?.sql).toMatch(
      /\("epoch", "sync_seq"\)$/,
    );
    expect(operationKey.map(({ name }) => name)).toEqual(['epoch', 'operation_id']);
    expect(household).toEqual({ id: 1, household_id: 'default', epoch: 1, initialized: 0 });
    expect(settings).toEqual({ id: 1, version: 1 });
    expect(shopping).toEqual([
      { id: 'shopping_list_active_default', name: '购物清单', status: 'ACTIVE', version: 1 },
    ]);
    expect((await call('/__test/migrate', { method: 'POST' })).status).toBe(204);
    const migrated = await inspect();
    expect(migrated.schema).toEqual(schema);
    expect(migrated.settings.version).toBe(5);
    expect(migrated.shopping.map(({ version }) => version)).toEqual([7]);
  });

  it('distinguishes invalid credentials, revoked members and OWNER-only access', async () => {
    const cases = [
      [null, 401, 'UNAUTHORIZED'],
      ['Basic invalid', 401, 'UNAUTHORIZED'],
      ['Bearer malformed token', 401, 'UNAUTHORIZED'],
      ['Bearer fixture-unknown', 401, 'UNAUTHORIZED'],
      [`Bearer ${revokedToken}`, 403, 'MEMBER_REVOKED'],
      [`Bearer ${memberToken}`, 403, 'FORBIDDEN'],
    ] as const;
    for (const [authorization, status, code] of cases) {
      await expectCode(
        await call('/__test/owner', { headers: authorization ? { authorization } : {} }),
        status,
        code,
      );
    }
    expect((await call('/__test/owner', { headers: auth(ownerToken) })).status).toBe(204);
  });

  it.each(['/api/sync/__test_echo', '/api/household/__test_echo'])(
    'forwards bytes that are invalid JSON through %s',
    async (route) => {
      const body = new Uint8Array([0x00, 0xff, 0x80, 0x41]);
      const path = `${route}?hello=world`;
      const response = await call(path, {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json', 'x-test-header': 'preserve' },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('x-test-url')).toBe(`${origin}${path}`);
      expect(response.headers.get('x-test-method')).toBe('POST');
      expect(response.headers.get('x-test-header')).toBe('preserve');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
    },
  );
});

describe('private R2 images on workerd', () => {
  it('authorizes both verbs and refuses a raw unregistered R2 object', async () => {
    const body = bytes('unregistered');
    const sha = digest(body);
    const path = `/api/sync/images/${sha}`;
    const bucket = await runtime.getR2Bucket();
    const looseKey = `images/${sha}/main/unregistered`;
    await bucket.put(looseKey, body);
    try {
      await expectCode(await call(path), 401, 'UNAUTHORIZED');
      await expectCode(await call(path, { headers: auth('fixture-unknown') }), 401, 'UNAUTHORIZED');
      await expectCode(await call(path, { headers: auth(revokedToken) }), 403, 'MEMBER_REVOKED');
      await expectCode(await call(path, { headers: auth() }), 404, 'NOT_FOUND');
      await expectCode(await call(path, { method: 'PUT', body }), 401, 'UNAUTHORIZED');
      await expectCode(await upload(body, path, {}, 'fixture-unknown'), 401, 'UNAUTHORIZED');
      await expectCode(await upload(body, path, {}, revokedToken), 403, 'MEMBER_REVOKED');
      expect(await bucket.head(looseKey)).toBeTruthy();
      expect((await inspect()).images).toHaveLength(0);
    } finally {
      await bucket.delete(looseKey);
    }
  });

  it('streams the main and thumbnail independently, with idempotence and conflict detection', async () => {
    const main = new Uint8Array(
      Buffer.from('UklGRhwAAABXRUJQVlA4TA8AAAAvAkAAAAfQ/4j+ByKi/wEA', 'base64'),
    );
    const thumbnail = new Uint8Array(
      Buffer.from('UklGRhwAAABXRUJQVlA4TA8AAAAvAEAAAAcQ/Y/+ByKi/wEA', 'base64'),
    );
    const path = `/api/sync/images/${digest(main)}`;
    const thumbPath = `${path}?variant=thumb`;
    const thumbHeaders = { [IMAGE_CONTENT_SHA256_HEADER]: digest(thumbnail) };

    const concurrent = await Promise.all([upload(main), upload(main)]);
    expect(concurrent.map(({ status }) => status)).toEqual([204, 204]);
    expect((await upload(thumbnail, thumbPath, thumbHeaders)).status).toBe(204);
    const registered = await imageState();
    expect(registered.bucketKeys).toHaveLength(2);
    expect(registered.bucketKeys).toEqual(
      registered.images.map(({ object_key }) => object_key).sort(),
    );
    expect(registered.images).toMatchObject([
      {
        asset_sha256: digest(main),
        content_sha256: digest(main),
        variant: 'main',
        mime_type: IMAGE_MIME_TYPE,
        size_bytes: main.length,
        epoch: 1,
        uploaded_by: 'member',
      },
      {
        asset_sha256: digest(main),
        content_sha256: digest(thumbnail),
        variant: 'thumb',
        mime_type: IMAGE_MIME_TYPE,
        size_bytes: thumbnail.length,
        epoch: 1,
        uploaded_by: 'member',
      },
    ]);
    expect((await upload(thumbnail, thumbPath, thumbHeaders)).status).toBe(204);
    const other = bytes('conflicting-thumbnail');
    await expectCode(
      await upload(other, thumbPath, { [IMAGE_CONTENT_SHA256_HEADER]: digest(other) }),
      409,
      'CONFLICT',
    );
    expect(await imageState()).toEqual(registered);

    for (const [route, body] of [
      [path, main],
      [thumbPath, thumbnail],
    ] as const) {
      const read = await call(route, { headers: auth(ownerToken) });
      expect(read.status).toBe(200);
      expect(read.headers.get('content-type')).toBe(IMAGE_MIME_TYPE);
      expect(read.headers.get('content-length')).toBe(String(body.length));
      expect(read.headers.get('etag')).toMatch(/^".+"$/);
      expect(read.headers.get('cache-control')).toBe('private, no-store');
      expect(new Uint8Array(await read.arrayBuffer())).toEqual(body);
    }
  });

  it('rejects bad lengths, digests and metadata without adding any R2 object or SQL row', async () => {
    const good = bytes('integrity-target');
    const bad = good.slice();
    bad[0] ^= 0xff;
    const path = `/api/sync/images/${digest(good)}`;
    const before = await imageState();
    const cases: {
      body: Uint8Array<ArrayBuffer>;
      path: string;
      headers: Record<string, string>;
      status: number;
      code: string;
    }[] = [
      { body: bad, path, headers: {}, status: 400, code: 'INVALID_FILE' },
      {
        body: bad,
        path: `${path}?variant=thumb`,
        headers: { [IMAGE_CONTENT_SHA256_HEADER]: digest(good) },
        status: 400,
        code: 'INVALID_FILE',
      },
      {
        body: good,
        path,
        headers: { 'content-type': 'image/png' },
        status: 415,
        code: 'INVALID_FILE',
      },
      {
        body: good,
        path,
        headers: { 'x-test-content-length': String(MAX_IMAGE_BYTES + 1) },
        status: 413,
        code: 'FILE_TOO_LARGE',
      },
      {
        body: good,
        path,
        headers: { 'x-test-content-length': String(good.length + 1) },
        status: 400,
        code: 'INVALID_FILE',
      },
      {
        body: good,
        path,
        headers: { 'x-test-content-length': String(good.length - 1) },
        status: 400,
        code: 'INVALID_FILE',
      },
      {
        body: good,
        path,
        headers: { 'x-test-content-length': '0' },
        status: 400,
        code: 'INVALID_FILE',
      },
      {
        body: good,
        path,
        headers: { 'x-test-content-length': 'missing' },
        status: 400,
        code: 'INVALID_FILE',
      },
      {
        body: good,
        path,
        headers: { [HOUSEHOLD_EPOCH_HEADER]: '2' },
        status: 409,
        code: 'EPOCH_MISMATCH',
      },
      {
        body: good,
        path: `${path}?variant=thumb`,
        headers: {},
        status: 400,
        code: 'VALIDATION_ERROR',
      },
      {
        body: good,
        path: `${path}?variant=other`,
        headers: {},
        status: 400,
        code: 'VALIDATION_ERROR',
      },
      {
        body: good,
        path: `/api/sync/images/${digest(good).toUpperCase()}`,
        headers: {},
        status: 400,
        code: 'VALIDATION_ERROR',
      },
    ];
    for (const scenario of cases) {
      await expectCode(
        await upload(scenario.body, scenario.path, scenario.headers),
        scenario.status,
        scenario.code,
      );
      expect(await imageState()).toEqual(before);
    }
    await expectCode(await call(path, { headers: auth() }), 404, 'NOT_FOUND');
  });

  it.each([
    ['revoke', 403, 'MEMBER_REVOKED'],
    ['epoch', 409, 'EPOCH_MISMATCH'],
    ['error', 500, 'INTERNAL_ERROR'],
  ] as const)(
    'deletes a completed R2 write when commit detects %s',
    async (action, status, code) => {
      const photo = bytes(`commit-${action}`);
      const sha = digest(photo);
      const path = `/api/sync/images/${sha}`;
      const before = await imageState();
      expect(
        (await call(`/__test/arm?digest=${sha}&action=${action}`, { method: 'POST' })).status,
      ).toBe(204);
      try {
        await expectCode(await upload(photo), status, code);
        expect(await imageState()).toEqual(before);
        await expectCode(await call(path, { headers: auth(ownerToken) }), 404, 'NOT_FOUND');
        if (action === 'revoke') {
          await expectCode(await call(path, { headers: auth() }), 403, 'MEMBER_REVOKED');
        }
        if (action === 'epoch') expect((await inspect()).household.epoch).toBe(2);
      } finally {
        await seed('member', memberToken);
        expect((await call('/__test/reset-epoch', { method: 'POST' })).status).toBe(204);
      }
    },
  );
});
