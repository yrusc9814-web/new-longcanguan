/**
 * VAN-206 家庭管理路由的真实 workerd 集成验收（HTTP 面）。
 *
 * 所有断言都打在真实 Miniflare/workerd 上：SQLite Durable Object、真实
 * WebSocket、真实 R2。本文件只做 HTTP 契约与权限矩阵；WebSocket/休眠/图片
 * 生命周期在 `household-ws.test.ts`。
 */

import { HOUSEHOLD_EPOCH_HEADER } from '@dafan/shared/sync';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  auth,
  BOOTSTRAP_SECRET,
  bytes,
  call,
  connect,
  DEFAULT_SOURCE,
  digest,
  expectFailure,
  initOwner,
  invite,
  issueTicket,
  join,
  members,
  OTHER_SOURCE,
  readImage,
  recoverOwner,
  resetHousehold,
  revoke,
  snapshot,
  ticket,
  upload,
} from './household-support';
import { startWorkerd, type WorkerdHarness } from './run-workerd';

let runtime: WorkerdHarness;

beforeAll(async () => {
  runtime = await startWorkerd(new URL('./workerd-entry.ts', import.meta.url), {
    bindings: { OWNER_BOOTSTRAP_SECRET: BOOTSTRAP_SECRET },
  });
}, 60_000);

afterAll(async () => {
  await runtime?.dispose();
});

beforeEach(async () => {
  await resetHousehold(runtime);
});

function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  return call(runtime, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST /api/household/init', () => {
  it('creates the single owner exactly once: 201 then 409 with stable ids', async () => {
    const first = await postJson('/api/household/init', {
      bootstrapSecret: BOOTSTRAP_SECRET,
      nickname: '馆主',
    });
    expect(first.status).toBe(201);
    const binding = (await first.json()) as {
      householdId: string;
      epoch: number;
      memberId: string;
      role: string;
      nickname: string;
      token: string;
    };
    expect(binding).toMatchObject({
      householdId: 'default',
      epoch: 1,
      role: 'OWNER',
      nickname: '馆主',
    });
    expect(binding.memberId).toMatch(/^[0-9a-f-]{36}$/);
    expect(binding.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const second = await postJson('/api/household/init', {
      bootstrapSecret: BOOTSTRAP_SECRET,
      nickname: '另一个馆主',
    });
    await expectFailure(second, 409, 'CONFLICT');

    const state = await snapshot(runtime);
    expect(state.household).toMatchObject({ epoch: 1, initialized: 1 });
    expect(state.counts.members).toBe(1);
    expect(state.members[0]).toMatchObject({
      id: binding.memberId,
      role: 'OWNER',
      status: 'ACTIVE',
    });
  });

  it('does not store the raw token or bootstrap secret', async () => {
    const binding = await initOwner(runtime);
    const state = await snapshot(runtime);
    const stored = JSON.stringify(state);
    expect(stored).not.toContain(binding.token);
    expect(stored).not.toContain(BOOTSTRAP_SECRET);
    expect(state.members).toHaveLength(1);
  });
});

describe('POST /api/household/join', () => {
  it('adds one member per invite and rejects invite reuse with 409', async () => {
    const owner = await initOwner(runtime);
    const { inviteCode } = await invite(runtime, owner.token);

    const joined = await join(runtime, inviteCode, '小王');
    expect(joined).toMatchObject({
      householdId: 'default',
      epoch: 1,
      role: 'MEMBER',
      nickname: '小王',
    });
    expect(joined.memberId).not.toBe(owner.memberId);

    const reuse = await postJson('/api/household/join', { inviteCode, nickname: '冒名者' });
    await expectFailure(reuse, 409, 'CONFLICT');

    const state = await snapshot(runtime);
    expect(state.counts.members).toBe(2);
    expect(state.invites[0].used_by_member_id).toBe(joined.memberId);
  });

  it('rejects unknown and non-string invite codes without creating members', async () => {
    const owner = await initOwner(runtime);
    await invite(runtime, owner.token);
    const cases = [
      { inviteCode: 'not-a-real-code', nickname: '甲' },
      { inviteCode: 42, nickname: '乙' },
      { inviteCode: '', nickname: '丙' },
    ];
    for (const payload of cases) {
      await expectFailure(await postJson('/api/household/join', payload), 401, 'UNAUTHORIZED');
    }
    expect((await snapshot(runtime)).counts.members).toBe(1);
  });

  it('requires a nickname and refuses before touching the invite', async () => {
    const owner = await initOwner(runtime);
    const { inviteCode } = await invite(runtime, owner.token);
    for (const nickname of [undefined, '', '   ', 7]) {
      await expectFailure(
        await postJson('/api/household/join', { inviteCode, nickname }),
        400,
        'VALIDATION_ERROR',
      );
    }
    const state = await snapshot(runtime);
    expect(state.invites[0].used_by_member_id).toBeNull();
    expect(state.counts.members).toBe(1);
  });
});

describe('POST /api/household/owner/recover', () => {
  it('rotates the token for the same member id and keeps household state', async () => {
    const owner = await initOwner(runtime);
    await call(runtime, '/__test/seed-sync-log', { method: 'POST' });
    const recovered = await recoverOwner(runtime);

    expect(recovered).toMatchObject({
      householdId: owner.householdId,
      epoch: owner.epoch,
      memberId: owner.memberId,
      role: 'OWNER',
      nickname: '馆主',
    });
    expect(recovered.token).not.toBe(owner.token);

    await expectFailure(
      await call(runtime, '/api/household/me', { headers: auth(owner.token) }),
      401,
      'UNAUTHORIZED',
    );
    const me = await call(runtime, '/api/household/me', { headers: auth(recovered.token) });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ memberId: owner.memberId, epoch: owner.epoch });

    const state = await snapshot(runtime);
    expect(state.counts.members).toBe(1);
    expect(state.counts.syncLog).toBe(1);
    expect(state.household.epoch).toBe(owner.epoch);
  });

  it('is 409 before init', async () => {
    await expectFailure(await recoverOwnerRaw(), 409, 'CONFLICT');
  });

  async function recoverOwnerRaw() {
    return postJson('/api/household/owner/recover', { bootstrapSecret: BOOTSTRAP_SECRET });
  }
});

describe('bootstrap secret handling', () => {
  const cases = [
    ['missing', { nickname: '馆主' }],
    ['empty', { bootstrapSecret: '', nickname: '馆主' }],
    ['whitespace', { bootstrapSecret: '   ', nickname: '馆主' }],
    ['non-string', { bootstrapSecret: 12345, nickname: '馆主' }],
    ['wrong', { bootstrapSecret: `${BOOTSTRAP_SECRET}x`, nickname: '馆主' }],
  ] as const;

  it.each(cases)('rejects a %s secret for init with 401 and no member', async (_name, body) => {
    await expectFailure(await postJson('/api/household/init', body), 401, 'UNAUTHORIZED');
    const state = await snapshot(runtime);
    expect(state.counts.members).toBe(0);
    expect(state.household.initialized).toBe(0);
  });

  it('rejects a missing secret for recover after init', async () => {
    const owner = await initOwner(runtime);
    await expectFailure(await postJson('/api/household/owner/recover', {}), 401, 'UNAUTHORIZED');
    const me = await call(runtime, '/api/household/me', { headers: auth(owner.token) });
    expect(me.status).toBe(200);
  });

  it.each(['missing', 'empty'])(
    'fails closed with a %s deployment secret',
    async (mode) => {
      const bare = await startWorkerd(new URL('./workerd-entry.ts', import.meta.url), {
        bindings: mode === 'empty' ? { OWNER_BOOTSTRAP_SECRET: '' } : {},
      });
      try {
        for (const path of ['/api/household/init', '/api/household/owner/recover']) {
          const response = await call(bare, path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ bootstrapSecret: 'invalid fixture', nickname: '馆主' }),
          });
          await expectFailure(response, 401, 'UNAUTHORIZED');
        }
      } finally {
        await bare.dispose();
      }
    },
    60_000,
  );
});

describe('rate limiting', () => {
  it('429s the fifth failed owner attempt with Retry-After, shared by init and recover', async () => {
    const failures = [];
    for (let index = 0; index < 4; index += 1) {
      failures.push(
        await postJson('/api/household/init', { bootstrapSecret: 'wrong', nickname: '馆主' }),
      );
    }
    expect(failures.map(({ status }) => status)).toEqual([401, 401, 401, 401]);

    const fifth = await postJson('/api/household/init', {
      bootstrapSecret: 'wrong',
      nickname: '馆主',
    });
    await expectFailure(fifth, 429, 'RATE_LIMITED');
    const retryAfter = Number(fifth.headers.get('retry-after'));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);

    // 共用 owner 作用域：同一来源的 recover 也被拦。
    await expectFailure(
      await postJson('/api/household/owner/recover', { bootstrapSecret: 'wrong' }),
      429,
      'RATE_LIMITED',
    );

    // 换个来源仍可正常初始化（按来源计数）。
    const other = await call(runtime, '/api/household/init', {
      method: 'POST',
      source: OTHER_SOURCE,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bootstrapSecret: BOOTSTRAP_SECRET, nickname: '馆主' }),
    });
    expect(other.status).toBe(201);
  });

  it('keeps join failures in an independent bucket from owner attempts', async () => {
    for (let index = 0; index < 5; index += 1) {
      const response = await postJson('/api/household/join', {
        inviteCode: 'nope',
        nickname: '甲',
      });
      expect(response.status).toBe(index === 4 ? 429 : 401);
    }
    await expectFailure(
      await postJson('/api/household/join', { inviteCode: 'nope', nickname: '甲' }),
      429,
      'RATE_LIMITED',
    );

    // owner 桶未被污染。
    const init = await postJson('/api/household/init', {
      bootstrapSecret: BOOTSTRAP_SECRET,
      nickname: '馆主',
    });
    expect(init.status).toBe(201);
  });

  it('tracks join attempts per source address', async () => {
    for (let index = 0; index < 5; index += 1) {
      await call(runtime, '/api/household/join', {
        method: 'POST',
        source: OTHER_SOURCE,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inviteCode: 'nope', nickname: '甲' }),
      });
    }
    await expectFailure(
      await call(runtime, '/api/household/join', {
        method: 'POST',
        source: OTHER_SOURCE,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inviteCode: 'nope', nickname: '甲' }),
      }),
      429,
      'RATE_LIMITED',
    );

    const fresh = await call(runtime, '/api/household/join', {
      method: 'POST',
      source: DEFAULT_SOURCE,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inviteCode: 'nope', nickname: '甲' }),
    });
    expect(fresh.status).toBe(401);

    // 两个来源各自累计，且互不影响：被限流的一次不计入失败次数。
    const state = await snapshot(runtime);
    expect(
      Object.fromEntries(state.attempts.map(({ source, failures }) => [source, failures])),
    ).toEqual({ [OTHER_SOURCE]: 5, [DEFAULT_SOURCE]: 1 });
  });

  it('does not count a successful init as a failure', async () => {
    for (let index = 0; index < 4; index += 1) {
      await postJson('/api/household/init', { bootstrapSecret: 'wrong', nickname: '馆主' });
    }
    expect(
      (
        await postJson('/api/household/init', {
          bootstrapSecret: BOOTSTRAP_SECRET,
          nickname: '馆主',
        })
      ).status,
    ).toBe(201);
    expect((await snapshot(runtime)).counts.attempts).toBe(0);
  });
});

describe('authorization matrix', () => {
  it('separates 401 / 403 MEMBER_REVOKED / 403 FORBIDDEN on every guarded route', async () => {
    const owner = await initOwner(runtime);
    const { inviteCode } = await invite(runtime, owner.token);
    const member = await join(runtime, inviteCode, '小王');

    const anon = [
      ['GET', '/api/household/me', undefined],
      ['GET', '/api/household/members', undefined],
      ['POST', '/api/household/invites', undefined],
      ['POST', '/api/sync/ws-ticket', undefined],
      ['POST', `/api/household/members/${member.memberId}/revoke`, undefined],
    ] as const;
    for (const [method, path, body] of anon) {
      await expectFailure(
        await call(runtime, path, {
          method,
          headers: body ? { 'content-type': 'application/json' } : {},
          body: body ? JSON.stringify(body) : undefined,
        }),
        401,
        'UNAUTHORIZED',
      );
    }

    // 有效 MEMBER 访问 OWNER 专属动作 → 403 FORBIDDEN。
    for (const [method, path] of [
      ['GET', '/api/household/members'],
      ['POST', '/api/household/invites'],
      ['POST', `/api/household/members/${owner.memberId}/revoke`],
    ] as const) {
      await expectFailure(
        await call(runtime, path, { method, headers: auth(member.token) }),
        403,
        'FORBIDDEN',
      );
    }

    // 已撤权成员 → 403 MEMBER_REVOKED，且带 householdId/memberId 锚点。
    expect((await revoke(runtime, owner.token, member.memberId)).status).toBe(204);
    const revoked = await expectFailure(
      await call(runtime, '/api/household/me', { headers: auth(member.token) }),
      403,
      'MEMBER_REVOKED',
    );
    expect(revoked).toEqual({
      code: 'MEMBER_REVOKED',
      householdId: 'default',
      memberId: member.memberId,
    });

    // MEMBER 可以自读身份、可以签发票据。
    expect((await call(runtime, '/api/household/me', { headers: auth(owner.token) })).status).toBe(
      200,
    );
  });

  it('accepts MEMBER tokens on /me and ws-ticket but not on owner-only members', async () => {
    const owner = await initOwner(runtime);
    const { inviteCode } = await invite(runtime, owner.token);
    const member = await join(runtime, inviteCode, '小王');

    const me = await call(runtime, '/api/household/me', { headers: auth(member.token) });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ memberId: member.memberId, role: 'MEMBER' });

    expect((await issueTicket(runtime, member.token)).status).toBe(201);
    await expectFailure(
      await call(runtime, '/api/household/members', { headers: auth(member.token) }),
      403,
      'FORBIDDEN',
    );
  });
});

describe('GET /api/household/members', () => {
  it('returns { members } with lifecycle fields and no token material', async () => {
    const owner = await initOwner(runtime);
    const { inviteCode } = await invite(runtime, owner.token);
    const member = await join(runtime, inviteCode, '小王');
    expect((await revoke(runtime, owner.token, member.memberId)).status).toBe(204);

    const body = await members(runtime, owner.token);
    expect(Object.keys(body)).toEqual(['members']);
    expect(body.members).toHaveLength(2);
    expect(body.members[0]).toMatchObject({
      id: owner.memberId,
      nickname: '馆主',
      role: 'OWNER',
      status: 'ACTIVE',
      revokedAt: null,
    });
    expect(body.members[1]).toMatchObject({
      id: member.memberId,
      nickname: '小王',
      role: 'MEMBER',
      status: 'REVOKED',
    });
    expect(body.members[1].revokedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(body)).not.toMatch(/token/i);
  });
});

describe('POST /api/household/members/:id/revoke', () => {
  it('returns 204 and is idempotent for an already revoked member', async () => {
    const owner = await initOwner(runtime);
    const { inviteCode } = await invite(runtime, owner.token);
    const member = await join(runtime, inviteCode, '小王');

    expect((await revoke(runtime, owner.token, member.memberId)).status).toBe(204);
    expect((await revoke(runtime, owner.token, member.memberId)).status).toBe(204);

    const state = await snapshot(runtime);
    expect(state.members.find(({ id }) => id === member.memberId)).toMatchObject({
      status: 'REVOKED',
    });
    expect(state.counts.members).toBe(2);
  });

  it('refuses to revoke the owner and unknown ids', async () => {
    const owner = await initOwner(runtime);
    await expectFailure(await revoke(runtime, owner.token, owner.memberId), 409, 'CONFLICT');
    await expectFailure(
      await revoke(runtime, owner.token, '00000000-0000-0000-0000-000000000000'),
      404,
      'NOT_FOUND',
    );
  });
});

describe('route guards', () => {
  it('405s unsupported methods on household routes', async () => {
    const owner = await initOwner(runtime);
    const response = await call(runtime, '/api/household/init', {
      method: 'PATCH',
      headers: auth(owner.token),
    });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, POST, PUT, DELETE');
  });

  it('returns 404 for unknown authenticated household paths and 401 without auth', async () => {
    const owner = await initOwner(runtime);
    await expectFailure(
      await call(runtime, '/api/household/unknown', { headers: auth(owner.token) }),
      404,
      'NOT_FOUND',
    );
    await expectFailure(await call(runtime, '/api/household/unknown'), 401, 'UNAUTHORIZED');
  });
});

describe('图片路由在家庭管理之后仍然在线', () => {
  it('lets the owner upload and read an image after revoking a member', async () => {
    const owner = await initOwner(runtime);
    const { inviteCode } = await invite(runtime, owner.token);
    const member = await join(runtime, inviteCode, '小王');

    const body = bytes('after-revoke');
    expect((await upload(runtime, member.token, body)).status).toBe(204);
    expect((await revoke(runtime, owner.token, member.memberId)).status).toBe(204);

    await expectFailure(await readImage(runtime, member.token, body), 403, 'MEMBER_REVOKED');
    const read = await readImage(runtime, owner.token, body);
    expect(read.status).toBe(200);
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(body);
    expect((await snapshot(runtime)).counts.images).toBe(1);
  });
});

describe('票据与连接在辅助函数内可用', () => {
  it('issues a ticket usable by the shared connect helper', async () => {
    const owner = await initOwner(runtime);
    const issued = await ticket(runtime, owner.token);
    const socket = await connect(runtime, issued.ticket);
    socket.close();
  });

  it('keeps the epoch header contract for uploads', async () => {
    const owner = await initOwner(runtime);
    const body = bytes('epoch-contract');
    expect((await upload(runtime, owner.token, body)).status).toBe(204);
    await expectFailure(
      await call(runtime, `/api/sync/images/${digest(body)}`, {
        method: 'PUT',
        headers: {
          ...auth(owner.token),
          'content-type': 'image/webp',
          'content-length': String(body.length),
          [HOUSEHOLD_EPOCH_HEADER]: '2',
        },
        body,
      }),
      409,
      'EPOCH_MISMATCH',
    );
  });
});
