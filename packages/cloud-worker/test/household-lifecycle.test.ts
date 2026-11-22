import { expect, it } from 'vitest';

import {
  auth,
  BOOTSTRAP_SECRET,
  bucketKeys,
  bytes,
  call,
  closeAllSockets,
  connect,
  digest,
  expectFailure,
  holdCommit,
  invite,
  issueTicket,
  join,
  readImage,
  recoverOwner,
  rejectedUpgrade,
  releaseCommit,
  revoke,
  snapshot,
  ticket,
  upload,
  waitFor,
  type Binding,
} from './household-support';
import { startWorkerd } from './run-workerd';

it('atomically binds all three identities and preserves their data across recovery and revocation', async () => {
  const runtime = await startWorkerd(new URL('./workerd-entry.ts', import.meta.url), {
    bindings: { OWNER_BOOTSTRAP_SECRET: BOOTSTRAP_SECRET },
  });
  try {
    const post = (path: string, body: object) =>
      call(runtime, path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const bind = async (requests: Promise<Response>[]) => {
      const results = await Promise.all(requests);
      expect(results.map(({ status }) => status).sort()).toEqual([201, 409, 409, 409]);
      return results.find(({ status }) => status === 201)!.json<Binding>();
    };
    const oldOwner = await bind(
      Array.from({ length: 4 }, () =>
        post('/api/household/init', { bootstrapSecret: BOOTSTRAP_SECRET, nickname: '馆主' }),
      ),
    );
    expect((await snapshot(runtime)).members.map(({ role }) => role)).toEqual(['OWNER']);
    const codeA = await invite(runtime, oldOwner.token);
    const memberA = await bind(
      Array.from({ length: 4 }, () =>
        post('/api/household/join', { inviteCode: codeA.inviteCode, nickname: '成员 A' }),
      ),
    );
    const codeB = await invite(runtime, oldOwner.token);
    const memberB = await join(runtime, codeB.inviteCode, '成员 B');
    const parties = [oldOwner, memberA, memberB];
    const issued = await Promise.all(parties.map(({ token }) => ticket(runtime, token)));
    const staleOwnerTicket = (await ticket(runtime, oldOwner.token)).ticket;
    const pendingATicket = (await ticket(runtime, memberA.token)).ticket;

    const before = await snapshot(runtime);
    const stored = JSON.stringify(before);
    for (const raw of [
      codeA.inviteCode,
      codeB.inviteCode,
      ...issued.map((entry) => entry.ticket),
    ]) {
      expect(stored).not.toContain(raw);
      expect(stored).toContain(digest(raw));
    }
    for (const [index, identity] of parties.entries()) {
      expect(stored).not.toContain(identity.token);
      expect(before.members.find(({ id }) => id === identity.memberId)?.token_hash).toBe(
        digest(identity.token),
      );
      const row = before.tickets.find(
        ({ ticket_hash }) => ticket_hash === digest(issued[index].ticket),
      );
      expect(row).toMatchObject({
        member_id: identity.memberId,
        token_hash: digest(identity.token),
      });
      expect(row!.expires_at - row!.created_at).toBe(30_000);
    }

    const [oldOwnerSocket, socketA, socketB] = await Promise.all(
      issued.map((entry) => connect(runtime, entry.ticket)),
    );
    const payloads = parties.map(({ role, nickname }) => bytes(`${role}-${nickname}`));
    for (const [index, { token }] of parties.entries()) {
      expect((await upload(runtime, token, payloads[index])).status).toBe(204);
      expect(
        new Uint8Array(await (await readImage(runtime, token, payloads[index])).arrayBuffer()),
      ).toEqual(payloads[index]);
    }
    expect((await call(runtime, '/__test/seed-sync-log', { method: 'POST' })).status).toBe(204);
    expect((await call(runtime, '/__test/migrate', { method: 'POST' })).status).toBe(204);
    const existing = await snapshot(runtime);
    await runtime.evictDurableObject();
    const revived = await snapshot(runtime);
    expect(revived.instanceId).not.toBe(existing.instanceId);
    expect(revived.sockets.map((entry) => entry?.memberId).sort()).toEqual(
      parties.map(({ memberId }) => memberId).sort(),
    );

    const owner = await recoverOwner(runtime, '新馆主');
    expect(owner).toMatchObject({
      memberId: oldOwner.memberId,
      epoch: oldOwner.epoch,
      nickname: '新馆主',
    });
    expect(owner.token).not.toBe(oldOwner.token);
    await expectFailure(
      await call(runtime, '/api/household/me', { headers: auth(oldOwner.token) }),
      401,
      'UNAUTHORIZED',
    );
    expect(await oldOwnerSocket.waitForClose()).toEqual({ code: 4001, reason: 'UNAUTHORIZED' });
    expect(oldOwnerSocket.frames).toEqual([]);
    // 馆主换票后旧票据的 token_hash 已失效：精确 401，而不是已踢成员的 403 锚点。
    const oldUpgrade = await rejectedUpgrade(runtime, staleOwnerTicket);
    expect(await expectFailure(oldUpgrade, 401, 'UNAUTHORIZED')).toEqual({
      code: 'UNAUTHORIZED',
    });

    const recovered = await snapshot(runtime);
    expect(recovered.household).toEqual(existing.household);
    expect(recovered.images).toEqual(existing.images);
    expect(existing.syncLog).toHaveLength(1);
    expect(recovered.syncLog).toEqual(existing.syncLog);
    expect(recovered.settings).toEqual(existing.settings);
    expect(recovered.shopping).toEqual(existing.shopping);
    expect(recovered.members.filter(({ role }) => role === 'MEMBER')).toEqual(
      existing.members.filter(({ role }) => role === 'MEMBER'),
    );
    expect(socketA.raw.readyState).toBe(WebSocket.OPEN);
    expect(socketB.raw.readyState).toBe(WebSocket.OPEN);
    for (const [index, { token }] of [owner, memberA, memberB].entries()) {
      const response = await readImage(runtime, token, payloads[index]);
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(payloads[index]);
      expect((await call(runtime, '/api/household/me', { headers: auth(token) })).status).toBe(200);
    }

    const ownerSocket = await connect(runtime, (await ticket(runtime, owner.token)).ticket);
    const committedKeys = await bucketKeys(runtime);
    const inFlight = bytes('pending member A');
    await holdCommit(runtime);
    const pending = upload(runtime, memberA.token, inFlight);
    try {
      expect(
        await waitFor(async () => (await bucketKeys(runtime)).length === committedKeys.length + 1),
      ).toBe(true);
      expect((await snapshot(runtime)).images).toEqual(existing.images);
      expect((await revoke(runtime, owner.token, memberA.memberId)).status).toBe(204);
    } finally {
      await releaseCommit(runtime);
    }
    const revoked = {
      code: 'MEMBER_REVOKED',
      householdId: memberA.householdId,
      memberId: memberA.memberId,
    };
    expect(await expectFailure(await pending, 403, revoked.code)).toEqual(revoked);
    expect(await bucketKeys(runtime)).toEqual(committedKeys);

    expect(await socketA.waitForClose()).toEqual({ code: 4003, reason: 'MEMBER_REVOKED' });
    expect(socketA.frames).toHaveLength(1);
    expect(JSON.parse(socketA.frames[0])).toEqual({
      type: revoked.code,
      householdId: revoked.householdId,
      memberId: revoked.memberId,
    });

    const denied = [
      call(runtime, '/api/household/me', { headers: auth(memberA.token) }),
      call(runtime, '/api/household/members', { headers: auth(memberA.token) }),
      call(runtime, '/api/household/invites', { method: 'POST', headers: auth(memberA.token) }),
      revoke(runtime, memberA.token, memberB.memberId),
      issueTicket(runtime, memberA.token),
      rejectedUpgrade(runtime, pendingATicket),
      readImage(runtime, memberA.token, payloads[0]),
      upload(runtime, memberA.token, bytes('revoked write')),
    ];
    for (const response of await Promise.all(denied)) {
      expect(await expectFailure(response, 403, revoked.code)).toEqual(revoked);
    }
    for (const [identity, socket] of [
      [owner, ownerSocket],
      [memberB, socketB],
    ] as const) {
      const body = bytes(`after revoke ${identity.role}`);
      expect((await upload(runtime, identity.token, body)).status).toBe(204);
      expect(
        new Uint8Array(await (await readImage(runtime, identity.token, body)).arrayBuffer()),
      ).toEqual(body);
      expect(socket.raw.readyState).toBe(WebSocket.OPEN);
      expect(socket.frames).toEqual([]);
    }
  } finally {
    await closeAllSockets();
    await runtime.dispose();
  }
}, 40_000);
