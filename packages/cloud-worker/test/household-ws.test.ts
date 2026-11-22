/**
 * VAN-206 的 WebSocket、票据、Hibernation 与图片中途撤权验收。
 *
 * 全部跑在真实 workerd 上：真实 `WebSocketPair` + Hibernation API、真实 DO
 * 驱逐（`unsafeEvictDurableObject(..., { webSockets: 'hibernate' })`）、真实 R2。
 */

import { HOUSEHOLD_EPOCH_HEADER, IMAGE_MIME_TYPE } from '@dafan/shared/sync';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
  expectUpgradeFailure,
  holdCommit,
  initOwner,
  invite,
  issueTicket,
  join,
  members,
  OTHER_SOURCE,
  readImage,
  recoverOwner,
  rejectedUpgrade,
  releaseCommit,
  resetHousehold,
  revoke,
  snapshot,
  ticket,
  upload,
  waitFor,
} from './household-support';
import { startWorkerd, type WorkerdHarness } from './run-workerd';

let runtime: WorkerdHarness;

beforeAll(async () => {
  runtime = await startWorkerd(new URL('./workerd-entry.ts', import.meta.url), {
    bindings: { OWNER_BOOTSTRAP_SECRET: BOOTSTRAP_SECRET },
  });
}, 60_000);

afterAll(async () => {
  await closeAllSockets();
  await runtime?.dispose();
});

beforeEach(async () => {
  // 上一个用例可能把提交闸门留在挂起状态；先释放，避免污染后续。
  await call(runtime, '/__test/release-commit', { method: 'POST' });
  await resetHousehold(runtime);
  // 图片登记是跨用例的持久状态，单独清掉，避免上一用例的行影响计数断言。
  const stub = await runtime.getStub();
  const cleared = await stub.fetch('https://test.invalid/__test/clear-images', { method: 'POST' });
  expect(cleared.status).toBe(204);
  const bucket = await runtime.getR2Bucket();
  const listed = await bucket.list();
  if (listed.objects.length > 0) await bucket.delete(listed.objects.map(({ key }) => key));
});

afterEach(async () => {
  await closeAllSockets();
});

/** 建馆主 + 一名成员，返回全部凭据。 */
async function household() {
  const owner = await initOwner(runtime);
  const { inviteCode } = await invite(runtime, owner.token);
  const member = await join(runtime, inviteCode, '小王');
  return { owner, member };
}

describe('POST /api/sync/ws-ticket', () => {
  it('issues { ticket, expiresAt } with a 30 second lifetime', async () => {
    const { owner } = await household();
    const before = Date.now();
    const issued = await ticket(runtime, owner.token);
    const expiresAt = Date.parse(issued.expiresAt);

    expect(issued.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Number.isFinite(expiresAt)).toBe(true);
    expect(expiresAt - before).toBeGreaterThan(28_000);
    expect(expiresAt - before).toBeLessThanOrEqual(30_500);

    const state = await snapshot(runtime);
    expect(state.counts.tickets).toBe(1);
    // 只存哈希，不存票据原文。
    expect(JSON.stringify(state)).not.toContain(issued.ticket);
    expect(state.tickets[0].expires_at).toBe(expiresAt);
  });

  it('requires an active member and 401s for unknown or missing tokens', async () => {
    const { owner, member } = await household();
    await expectFailure(await issueTicket(runtime, 'not-a-token'), 401, 'UNAUTHORIZED');
    await expectFailure(
      await call(runtime, '/api/sync/ws-ticket', { method: 'POST' }),
      401,
      'UNAUTHORIZED',
    );

    expect((await revoke(runtime, owner.token, member.memberId)).status).toBe(204);
    const revoked = await expectFailure(
      await issueTicket(runtime, member.token),
      403,
      'MEMBER_REVOKED',
    );
    expect(revoked).toMatchObject({ householdId: 'default', memberId: member.memberId });
  });
});

describe('GET /api/sync/ws', () => {
  it('accepts the ticket exactly once (atomic consume)', async () => {
    const { owner } = await household();
    const issued = await ticket(runtime, owner.token);

    const socket = await connect(runtime, issued.ticket);
    expect((await snapshot(runtime)).counts.tickets).toBe(0);

    // 同一票据不能建立第二条连接。
    await expectUpgradeFailure(runtime, issued.ticket, 401, 'UNAUTHORIZED');
    socket.close();
  });

  it('rejects a reused ticket even while the first socket is alive', async () => {
    const { owner } = await household();
    const issued = await ticket(runtime, owner.token);
    const first = await connect(runtime, issued.ticket);
    const second = await rejectedUpgrade(runtime, issued.ticket);
    expect(second.status).toBe(401);
    first.close();
  });

  it('rejects expired tickets', async () => {
    const { owner } = await household();
    const issued = await ticket(runtime, owner.token);
    expect((await call(runtime, '/__test/expire-tickets', { method: 'POST' })).status).toBe(204);

    await expectUpgradeFailure(runtime, issued.ticket, 401, 'UNAUTHORIZED');
    expect((await snapshot(runtime)).counts.tickets).toBe(0);
  });

  it('rejects missing tickets and non-upgrade requests', async () => {
    await expectFailure(
      await call(runtime, '/api/sync/ws?ticket=anything'),
      400,
      'VALIDATION_ERROR',
    );
    await expectFailure(await rejectedUpgrade(runtime), 401, 'UNAUTHORIZED');
  });

  it('separates a rotated owner ticket (401) from a revoked member ticket (403) with exact bodies', async () => {
    const { owner, member } = await household();
    const staleOwner = await ticket(runtime, owner.token);
    const memberTicket = await ticket(runtime, member.token);
    const rotated = await recoverOwner(runtime, '新馆主');

    // 馆主换票后，旧票据对应的 token_hash 已不在成员表：精确 401，且不带任何锚点。
    const stale = await rejectedUpgrade(runtime, staleOwner.ticket);
    expect(await expectFailure(stale, 401, 'UNAUTHORIZED')).toEqual({ code: 'UNAUTHORIZED' });

    // 已踢成员的票据仍能解出成员，但会话撤权：精确 403 锚定 householdId + memberId。
    expect((await revoke(runtime, rotated.token, member.memberId)).status).toBe(204);
    const kicked = await rejectedUpgrade(runtime, memberTicket.ticket);
    expect(await expectFailure(kicked, 403, 'MEMBER_REVOKED')).toEqual({
      code: 'MEMBER_REVOKED',
      householdId: member.householdId,
      memberId: member.memberId,
    });

    // 新馆主票据不受影响，仍可建立真实连接。
    const socket = await connect(runtime, (await ticket(runtime, rotated.token)).ticket);
    socket.close();
  });
});

describe('成员撤权：精确帧与 4003，且不影响馆主/其他成员', () => {
  it('sends the exact MEMBER_REVOKED frame then closes 4003 for the revoked member only', async () => {
    const { owner, member } = await household();
    const third = await join(runtime, (await invite(runtime, owner.token)).inviteCode, '小李');

    const ownerSocket = await connect(runtime, (await ticket(runtime, owner.token)).ticket);
    const memberSocket = await connect(runtime, (await ticket(runtime, member.token)).ticket);
    const thirdSocket = await connect(runtime, (await ticket(runtime, third.token)).ticket);

    expect((await snapshot(runtime)).sockets.map((socket) => socket?.memberId).sort()).toEqual(
      [owner.memberId, member.memberId, third.memberId].sort(),
    );

    expect((await revoke(runtime, owner.token, member.memberId)).status).toBe(204);

    const frame = await memberSocket.waitForFrame((value) => value.includes('MEMBER_REVOKED'));
    expect(JSON.parse(frame)).toEqual({
      type: 'MEMBER_REVOKED',
      householdId: 'default',
      memberId: member.memberId,
    });
    const close = await memberSocket.waitForClose();
    expect(close.code).toBe(4003);
    expect(close.reason).toBe('MEMBER_REVOKED');

    // 馆主与第三名成员仍在线，仅收到初始连接帧。
    await new Promise((resolve) => setTimeout(resolve, 300));
    const connected = expect.stringMatching(
      /^\{"type":"SYNC_CONNECTED","connectionId":"[0-9a-f-]+"\}$/,
    );
    expect(ownerSocket.frames).toEqual([connected]);
    expect(ownerSocket.closes).toEqual([]);
    expect(thirdSocket.frames).toEqual([connected]);
    expect(thirdSocket.closes).toEqual([]);

    // 他们的票据与身份仍然可用。
    expect((await call(runtime, '/api/household/me', { headers: auth(owner.token) })).status).toBe(
      200,
    );
    expect((await call(runtime, '/api/household/me', { headers: auth(third.token) })).status).toBe(
      200,
    );

    ownerSocket.close();
    thirdSocket.close();
  }, 20_000);

  it('does not send a revocation frame on an ordinary disconnect', async () => {
    const { owner } = await household();
    const socket = await connect(runtime, (await ticket(runtime, owner.token)).ticket);

    expect(
      (
        await call(runtime, '/__test/close-sockets?code=4001&reason=UNAUTHORIZED', {
          method: 'POST',
        })
      ).status,
    ).toBe(204);
    const close = await socket.waitForClose();
    expect(close.code).toBe(4001);
    expect(socket.frames.map((frame) => JSON.parse(frame).type)).toEqual(['SYNC_CONNECTED']);
  }, 20_000);

  it('reauthorizes a sleeping connection when its next message wakes the DO', async () => {
    const { member } = await household();
    const socket = await connect(runtime, (await ticket(runtime, member.token)).ticket);
    const before = await snapshot(runtime);
    // Simulate a committed revocation whose active notification was interrupted.
    const result = await call(
      runtime,
      `/__test/revoke-without-notifying?memberId=${member.memberId}`,
      {
        method: 'POST',
      },
    );
    expect(result.status).toBe(204);
    await runtime.evictDurableObject();
    socket.send('resume');
    const frame = await socket.waitForFrame((value) => value.includes('MEMBER_REVOKED'));
    expect(JSON.parse(frame)).toEqual({
      type: 'MEMBER_REVOKED',
      householdId: member.householdId,
      memberId: member.memberId,
    });
    expect((await socket.waitForClose()).code).toBe(4003);
    expect((await snapshot(runtime)).instanceId).not.toBe(before.instanceId);
  }, 20_000);

  it('keeps the revoked member in the members list with its revoked status', async () => {
    const { owner, member } = await household();
    expect((await revoke(runtime, owner.token, member.memberId)).status).toBe(204);
    const body = await members(runtime, owner.token);
    expect(body.members).toHaveLength(2);
    expect(body.members[1]).toMatchObject({ id: member.memberId, status: 'REVOKED' });
  });
});

describe('真实 Hibernation 恢复', () => {
  it('rebuilds the DO instance while the socket and its attachment survive', async () => {
    const { owner, member } = await household();
    await call(runtime, '/__test/seed-sync-log', { method: 'POST' });
    const before = await snapshot(runtime);

    const memberSocket = await connect(runtime, (await ticket(runtime, member.token)).ticket);
    const ownerSocket = await connect(runtime, (await ticket(runtime, owner.token)).ticket);
    expect((await snapshot(runtime)).instanceId).toBe(before.instanceId);

    await runtime.evictDurableObject();
    await new Promise((resolve) => setTimeout(resolve, 250));

    const after = await snapshot(runtime);
    // 实例确实重建了（字段重新初始化），但家庭数据与 socket attachment 仍在。
    expect(after.instanceId).not.toBe(before.instanceId);
    expect(after.household).toEqual(before.household);
    expect(after.counts.members).toBe(2);
    expect(after.counts.syncLog).toBe(1);
    expect(after.sockets.map((socket) => socket?.memberId).sort()).toEqual(
      [owner.memberId, member.memberId].sort(),
    );

    // 休眠后的 socket 依然可用：撤权仍能送达精确帧并 4003。
    expect((await revoke(runtime, owner.token, member.memberId)).status).toBe(204);
    const frame = await memberSocket.waitForFrame((value) => value.includes('MEMBER_REVOKED'));
    expect(JSON.parse(frame)).toEqual({
      type: 'MEMBER_REVOKED',
      householdId: 'default',
      memberId: member.memberId,
    });
    expect((await memberSocket.waitForClose()).code).toBe(4003);
    expect(ownerSocket.closes).toEqual([]);
    ownerSocket.close();
  }, 20_000);

  it('survives repeated evictions without duplicating members or tickets', async () => {
    const { owner } = await household();
    const socket = await connect(runtime, (await ticket(runtime, owner.token)).ticket);
    const baseline = await snapshot(runtime);

    for (let round = 0; round < 3; round += 1) {
      // 驱逐前先唤醒实例（休眠中的 DO 不满足 unsafeEvict 的“正在运行”前提）。
      await snapshot(runtime);
      await runtime.evictDurableObject();
      await new Promise((resolve) => setTimeout(resolve, 120));
    }

    const after = await snapshot(runtime);
    expect(after.instanceId).not.toBe(baseline.instanceId);
    expect(after.counts.members).toBe(baseline.counts.members);
    expect(after.counts.invites).toBe(baseline.counts.invites);
    expect(after.counts.tickets).toBe(0);
    expect(after.sockets).toHaveLength(1);
    socket.close();
  });
});

describe('A 在途 PUT 真正走 revoke 后被拦截并清理', () => {
  it('revokes through the real route mid-upload, refuses the commit and deletes the R2 object', async () => {
    const { owner, member } = await household();
    const body = bytes('in-flight-revoke');
    const sha = digest(body);

    await holdCommit(runtime);
    const pending = upload(runtime, member.token, body);

    // 等到 R2 已经落下对象、DO 尚未登记。
    const written = await waitFor(async () => (await bucketKeys(runtime)).length === 1);
    expect(written).toBe(true);
    expect((await snapshot(runtime)).counts.images).toBe(0);

    // 真正的撤权路由（不是 SQL 掉状态）。
    expect((await revoke(runtime, owner.token, member.memberId)).status).toBe(204);

    await releaseCommit(runtime);
    const response = await pending;
    await expectFailure(response, 403, 'MEMBER_REVOKED');

    // R2 临时对象被真正删除，SQL 无登记，读取被拒。
    expect(await bucketKeys(runtime)).toEqual([]);
    expect((await snapshot(runtime)).counts.images).toBe(0);
    expect(
      (await call(runtime, `/api/sync/images/${sha}`, { headers: auth(owner.token) })).status,
    ).toBe(404);
    const revokedRead = await readImage(runtime, member.token, body);
    await expectFailure(revokedRead, 403, 'MEMBER_REVOKED');
  });

  it('does not disturb a concurrent owner upload while revoking a member', async () => {
    const { owner, member } = await household();
    const ownerBody = bytes('owner-concurrent');
    const memberBody = bytes('member-concurrent');

    await holdCommit(runtime);
    const pendingMember = upload(runtime, member.token, memberBody);
    expect(await waitFor(async () => (await bucketKeys(runtime)).length === 1)).toBe(true);

    // 馆主的上传走另一条真实请求，不经过闸门（闸门只作用于当前那一次 commit）。
    const ownerUpload = await upload(runtime, owner.token, ownerBody);
    expect(ownerUpload.status).toBe(204);

    expect((await revoke(runtime, owner.token, member.memberId)).status).toBe(204);
    await releaseCommit(runtime);

    await expectFailure(await pendingMember, 403, 'MEMBER_REVOKED');

    const keys = await bucketKeys(runtime);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain(digest(ownerBody));

    const ownerRead = await readImage(runtime, owner.token, ownerBody);
    expect(ownerRead.status).toBe(200);
    expect(new Uint8Array(await ownerRead.arrayBuffer())).toEqual(ownerBody);
    await expectFailure(await readImage(runtime, member.token, memberBody), 403, 'MEMBER_REVOKED');
  });

  it('lets the owner retry cleanly after the interrupted upload was rolled back', async () => {
    const { owner, member } = await household();
    const body = bytes('retry-after-revoke');
    await holdCommit(runtime);
    const pending = upload(runtime, member.token, body);
    expect(await waitFor(async () => (await bucketKeys(runtime)).length === 1)).toBe(true);
    expect((await revoke(runtime, owner.token, member.memberId)).status).toBe(204);
    await releaseCommit(runtime);
    await expectFailure(await pending, 403, 'MEMBER_REVOKED');

    // 撤权不破坏馆主上传同一份字节的能力。
    expect((await upload(runtime, owner.token, body)).status).toBe(204);
    const read = await readImage(runtime, owner.token, body);
    expect(read.status).toBe(200);
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(body);
  });
});

describe('三方 R2/WS 复核', () => {
  it('serves the same image bytes to owner and a second member', async () => {
    const { owner, member } = await household();
    const body = bytes('three-way');
    expect((await upload(runtime, owner.token, body)).status).toBe(204);

    for (const token of [owner.token, member.token]) {
      const read = await readImage(runtime, token, body);
      expect(read.status).toBe(200);
      expect(read.headers.get('content-type')).toBe(IMAGE_MIME_TYPE);
      expect(read.headers.get('cache-control')).toBe('private, no-store');
      expect(new Uint8Array(await read.arrayBuffer())).toEqual(body);
    }

    // 第三方（馆主签发的新成员）也能读；撤权后不能。
    const third = await join(runtime, (await invite(runtime, owner.token)).inviteCode, '小李');
    expect((await readImage(runtime, third.token, body)).status).toBe(200);
    expect((await revoke(runtime, owner.token, third.memberId)).status).toBe(204);
    await expectFailure(await readImage(runtime, third.token, body), 403, 'MEMBER_REVOKED');

    const keys = await bucketKeys(runtime);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain(digest(body));
    expect((await snapshot(runtime)).counts.images).toBe(1);
  });

  it('keeps uploads working for a re-joined member on a new invite and new epoch header', async () => {
    const { owner, member } = await household();
    expect((await revoke(runtime, owner.token, member.memberId)).status).toBe(204);

    const rejoin = await join(runtime, (await invite(runtime, owner.token)).inviteCode, '小王');
    const body = bytes('rejoined');
    expect(
      (
        await upload(runtime, rejoin.token, body, {
          epoch: String((await snapshot(runtime)).household.epoch),
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await call(runtime, `/api/sync/images/${digest(body)}`, {
          method: 'PUT',
          headers: {
            ...auth(rejoin.token),
            'content-type': IMAGE_MIME_TYPE,
            'content-length': String(body.length),
            [HOUSEHOLD_EPOCH_HEADER]: '99',
          },
          body,
        })
      ).status,
    ).toBe(409);
  });

  it('does not leak another household member socket frame on unrelated traffic', async () => {
    const { member } = await household();
    const memberSocket = await connect(runtime, (await ticket(runtime, member.token)).ticket);

    expect(
      (await call(runtime, '/__test/send-frame?frame=%7B%22probe%22%3A1%7D', { method: 'POST' }))
        .status,
    ).toBe(200);
    expect(await memberSocket.waitForFrame((value) => value.includes('probe'))).toBe('{"probe":1}');
    expect(memberSocket.closes).toEqual([]);

    // 别的来源的失败尝试不产生任何帧。
    for (let index = 0; index < 3; index += 1) {
      await call(runtime, '/api/household/join', {
        method: 'POST',
        source: OTHER_SOURCE,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inviteCode: 'nope', nickname: '甲' }),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(memberSocket.frames.slice(1)).toEqual(['{"probe":1}']);
    expect(memberSocket.closes).toEqual([]);
    memberSocket.close();
  });
});
