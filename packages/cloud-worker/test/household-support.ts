/**
 * VAN-206 家庭管理集成验收所共用的测试驱动。
 *
 * 与 `run-workerd.ts` 的分工：脚手架负责“让请求真的进入 workerd”，本文件负责
 * “按生产契约说话”——真实 bootstrap secret、真实票据、真实 WebSocket 生命周期
 * 以及可断言的客户端帧缓冲。所有导出都是测试专用，不进入生产 bundle。
 */

import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';

import { HOUSEHOLD_EPOCH_HEADER, IMAGE_MIME_TYPE } from '@dafan/shared/sync';
import { expect } from 'vitest';

import type { WorkerdHarness } from './run-workerd';

export const ORIGIN = 'https://cloud.dafan.test';
export const BOOTSTRAP_SECRET = randomBytes(32).toString('base64url');
export const OTHER_SOURCE = '203.0.113.9';
export const DEFAULT_SOURCE = '203.0.113.7';

const openSockets = new Set<WebSocket>();

function trackSocket(socket: WebSocket): void {
  openSockets.add(socket);
  socket.addEventListener('close', () => openSockets.delete(socket));
}

export async function closeAllSockets(): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const socket of openSockets) {
    if (socket.readyState === WebSocket.CLOSED) continue;
    pending.push(
      new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timeout);
          socket.removeEventListener('close', done);
          resolve();
        };
        const timeout = setTimeout(done, 1_000);
        socket.addEventListener('close', done, { once: true });
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close(1000);
        }
      }),
    );
  }
  openSockets.clear();
  await Promise.all(pending);
}

export function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** 家庭初始化/加入/恢复的完整绑定响应。 */
export interface Binding {
  householdId: string;
  epoch: number;
  memberId: string;
  role: 'OWNER' | 'MEMBER';
  nickname: string;
  token: string;
}

export interface MemberRow {
  id: string;
  nickname: string;
  role: string;
  status: string;
  revoked_at: string | null;
  token_hash: string;
}

export interface TicketRow {
  ticket_hash: string;
  member_id: string;
  token_hash: string;
  created_at: number;
  expires_at: number;
}

export interface AttemptRow {
  scope: string;
  source: string;
  failures: number;
  expires_at: number;
}

/** 成员列表的公开字段（服务端不回传 token_hash）。 */
export interface PublicMember {
  id: string;
  nickname: string;
  role: 'OWNER' | 'MEMBER';
  status: 'ACTIVE' | 'REVOKED';
  createdAt: string;
  revokedAt: string | null;
}

export interface SocketSummary {
  memberId?: string;
  role?: string;
}

export interface Snapshot {
  household: { id: number; household_id: string; epoch: number; initialized: number };
  instanceId: string;
  members: MemberRow[];
  invites: {
    code_hash: string;
    created_by: string;
    expires_at: string;
    used_by_member_id: string | null;
  }[];
  tickets: TicketRow[];
  attempts: AttemptRow[];
  sockets: (SocketSummary | null)[];
  images: { object_key: string }[];
  settings: { id: number; version: number };
  shopping: { id: string; name: string; status: string; version: number }[];
  syncLog: { epoch: number; sync_seq: number; entity_id: string }[];
  counts: {
    members: number;
    activeMembers: number;
    invites: number;
    tickets: number;
    attempts: number;
    syncLog: number;
    images: number;
  };
}

export interface CallOptions extends RequestInit {
  source?: string;
}

/** 统一的请求入口：默认带 `cf-connecting-ip`，便于验证按来源限流。 */
export function call(
  runtime: WorkerdHarness,
  path: string,
  init: CallOptions = {},
): Promise<Response> {
  const { source = DEFAULT_SOURCE, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (!headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip', source);
  return runtime.dispatchFetch(`${ORIGIN}${path}`, { ...rest, headers });
}

export async function snapshot(runtime: WorkerdHarness): Promise<Snapshot> {
  const response = await call(runtime, '/__test/inspect');
  expect(response.status).toBe(200);
  return (await response.json()) as Snapshot;
}

export async function expectFailure(
  response: Response,
  status: number,
  code: string,
): Promise<Record<string, unknown>> {
  const body = (await response.json()) as Record<string, unknown>;
  expect(response.status, `${response.status}: ${JSON.stringify(body)}`).toBe(status);
  expect(body.code).toBe(code);
  return body;
}

/** 复位家庭状态（成员/邀请/票据/尝试计数），保留已迁移的业务表。 */
export async function resetHousehold(runtime: WorkerdHarness): Promise<void> {
  const response = await call(runtime, '/__test/reset-household', { method: 'POST' });
  expect(response.status).toBe(204);
}

export async function initOwner(
  runtime: WorkerdHarness,
  nickname = '馆主',
  source = DEFAULT_SOURCE,
): Promise<Binding> {
  const response = await call(runtime, '/api/household/init', {
    method: 'POST',
    source,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bootstrapSecret: BOOTSTRAP_SECRET, nickname }),
  });
  expect(response.status, `init failed: ${await response.clone().text()}`).toBe(201);
  return (await response.json()) as Binding;
}

export async function recoverOwner(
  runtime: WorkerdHarness,
  nickname?: string,
  source = DEFAULT_SOURCE,
): Promise<Binding> {
  const response = await call(runtime, '/api/household/owner/recover', {
    method: 'POST',
    source,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bootstrapSecret: BOOTSTRAP_SECRET, ...(nickname ? { nickname } : {}) }),
  });
  expect(response.status, `recover failed: ${await response.clone().text()}`).toBe(200);
  return (await response.json()) as Binding;
}

export async function invite(runtime: WorkerdHarness, ownerToken: string) {
  const response = await call(runtime, '/api/household/invites', {
    method: 'POST',
    headers: auth(ownerToken),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { inviteCode: string; expiresAt: string };
}

export async function join(
  runtime: WorkerdHarness,
  inviteCode: string,
  nickname: string,
  source = DEFAULT_SOURCE,
): Promise<Binding> {
  const response = await call(runtime, '/api/household/join', {
    method: 'POST',
    source,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inviteCode, nickname }),
  });
  expect(response.status, `join failed: ${await response.clone().text()}`).toBe(201);
  return (await response.json()) as Binding;
}

export async function members(
  runtime: WorkerdHarness,
  ownerToken: string,
): Promise<{ members: PublicMember[] }> {
  const response = await call(runtime, '/api/household/members', {
    headers: auth(ownerToken),
  });
  expect(response.status).toBe(200);
  return response.json();
}

export async function revoke(
  runtime: WorkerdHarness,
  ownerToken: string,
  memberId: string,
): Promise<Response> {
  return call(runtime, `/api/household/members/${memberId}/revoke`, {
    method: 'POST',
    headers: auth(ownerToken),
  });
}

export async function issueTicket(runtime: WorkerdHarness, token: string): Promise<Response> {
  return call(runtime, '/api/sync/ws-ticket', { method: 'POST', headers: auth(token) });
}

export async function ticket(runtime: WorkerdHarness, token: string) {
  const response = await issueTicket(runtime, token);
  expect(response.status, `ticket failed: ${await response.clone().text()}`).toBe(201);
  return (await response.json()) as { ticket: string; expiresAt: string };
}

/** 客户端侧的可断言 WebSocket 包装：缓冲消息与关闭帧，便于等待精确帧。 */
export interface TestSocket {
  readonly raw: WebSocket;
  readonly frames: string[];
  readonly closes: { code: number; reason: string }[];
  waitForFrame(predicate: (frame: string) => boolean, timeoutMs?: number): Promise<string>;
  waitForClose(timeoutMs?: number): Promise<{ code: number; reason: string }>;
  send(data: string): void;
  close(): void;
}

function wrapSocket(raw: WebSocket): TestSocket {
  const frames: string[] = [];
  const closes: { code: number; reason: string }[] = [];
  trackSocket(raw);
  const waiters: (() => void)[] = [];
  const notify = () => {
    for (const waiter of waiters.splice(0)) waiter();
  };

  raw.addEventListener('message', (event) => {
    frames.push(String((event as MessageEvent).data));
    notify();
  });
  raw.addEventListener('close', (event) => {
    const detail = event as CloseEvent;
    closes.push({ code: detail.code, reason: detail.reason });
    notify();
  });

  async function waitUntil<T>(probe: () => T | undefined, timeoutMs: number): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = probe();
      if (value !== undefined) return value;
      if (Date.now() > deadline) throw new Error('timed out waiting for socket state');
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  return {
    raw,
    frames,
    closes,
    waitForFrame: (predicate, timeoutMs = 5_000) =>
      waitUntil(() => frames.find(predicate), timeoutMs) as Promise<string>,
    // workerd can keep the TCP connection up while completing the close handshake.
    waitForClose: (timeoutMs = 15_000) =>
      waitUntil(() => closes[0], timeoutMs) as Promise<{ code: number; reason: string }>,
    send: (data) => raw.send(data),
    close: () => raw.close(1000),
  };
}

/** 用票据建立一条真实 WebSocket（必须走 workerd 的 upgrade 通道）。 */
export async function connect(runtime: WorkerdHarness, ticketValue: string): Promise<TestSocket> {
  const url = new URL(
    `/api/sync/ws?ticket=${encodeURIComponent(ticketValue)}`,
    await runtime.mf.ready,
  );
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const raw = new WebSocket(url.href);
  const socket = wrapSocket(raw);
  await new Promise<void>((resolve, reject) => {
    raw.addEventListener('open', () => resolve(), { once: true });
    raw.addEventListener('error', () => reject(new Error('WebSocket upgrade failed')), {
      once: true,
    });
  });
  return socket;
}

// Node's WebSocket client does not expose the HTTP body on rejected upgrades.
export async function rejectedUpgrade(
  runtime: WorkerdHarness,
  ticketValue?: string,
): Promise<Response> {
  const url = new URL('/api/sync/ws', await runtime.mf.ready);
  if (ticketValue !== undefined) url.searchParams.set('ticket', ticketValue);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url.href,
      {
        headers: {
          upgrade: 'websocket',
          connection: 'Upgrade',
          'sec-websocket-version': '13',
          'sec-websocket-key': randomBytes(16).toString('base64'),
        },
      },
      async (response) => {
        response.setEncoding('utf8');
        try {
          let body = '';
          for await (const chunk of response) body += chunk;
          resolve(new Response(body, { status: response.statusCode }));
        } catch (error) {
          reject(error);
        }
      },
    );
    request.on('error', reject);
    request.on('upgrade', (_, socket) => {
      socket.destroy();
      reject(new Error('Invalid ticket connected successfully'));
    });
    request.end();
  });
}

export async function expectUpgradeFailure(
  runtime: WorkerdHarness,
  ticketValue: string,
  status: number,
  code: string,
): Promise<void> {
  await expectFailure(await rejectedUpgrade(runtime, ticketValue), status, code);
}

export function bytes(label: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(`RIFF\0WEBP\0${label}`));
}

export async function upload(
  runtime: WorkerdHarness,
  token: string,
  body: Uint8Array<ArrayBuffer>,
  options: { epoch?: string; key?: string } = {},
): Promise<Response> {
  const sha = digest(body);
  return call(runtime, `/api/sync/images/${sha}`, {
    method: 'PUT',
    headers: {
      ...auth(token),
      'content-type': IMAGE_MIME_TYPE,
      'content-length': String(body.length),
      [HOUSEHOLD_EPOCH_HEADER]: options.epoch ?? '1',
    },
    body,
  });
}

export async function readImage(
  runtime: WorkerdHarness,
  token: string,
  body: Uint8Array<ArrayBuffer>,
): Promise<Response> {
  return call(runtime, `/api/sync/images/${digest(body)}`, { headers: auth(token) });
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

/** 打开 R2 可见性窗口：让下一次图片提交停在 R2 写完、DO 登记之前。 */
export async function holdCommit(runtime: WorkerdHarness): Promise<void> {
  const response = await call(runtime, '/__test/hold-commit', { method: 'POST' });
  expect(response.status).toBe(204);
}

export async function releaseCommit(runtime: WorkerdHarness): Promise<void> {
  const response = await call(runtime, '/__test/release-commit', { method: 'POST' });
  expect(response.status).toBe(204);
}

/** R2 桶内以 `images/` 开头的对象键（按 key 排序）。 */
export async function bucketKeys(runtime: WorkerdHarness): Promise<string[]> {
  const bucket = await runtime.getR2Bucket();
  const listed = await bucket.list({ prefix: 'images/' });
  return listed.objects.map(({ key }) => key).sort();
}
