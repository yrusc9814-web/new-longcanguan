import type {
  HouseholdBinding,
  HouseholdIdentity,
  HouseholdInviteResponse,
  HouseholdMember,
  HouseholdMembersResponse,
  HouseholdRole,
  MemberRevokedFrame,
  WebSocketTicketResponse,
} from '@dafan/shared/sync';
import { DurableObject } from 'cloudflare:workers';

import {
  constantTimeSecretMatches,
  generateCredential,
  hashBearer,
  hashCredential,
  requireMember,
} from './auth';
import { AuthAttempts } from './auth-attempts';
import { cloudError, type CloudFailure } from './http';
import {
  parseImageTarget,
  parseImageUpload,
  type ImageCommit,
  type ImagePreflight,
  type ImageRead,
  type ImageTarget,
  type ImageUploadRequest,
  type PendingImageUpload,
} from './image-protocol';
import type { Env } from './index';
import { migrateHousehold } from './schema';

const EPOCH_MISMATCH = { code: 'EPOCH_MISMATCH', status: 409 } as const;
const NOT_FOUND = { code: 'NOT_FOUND', status: 404 } as const;
const CONFLICT = { code: 'CONFLICT', status: 409 } as const;
const VALIDATION_ERROR = { code: 'VALIDATION_ERROR', status: 400 } as const;
const UNAUTHORIZED = { code: 'UNAUTHORIZED', status: 401 } as const;
const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const WS_TICKET_TTL_MS = 30_000;
const MAX_AUTH_BODY_BYTES = 16_384;
const HUB_METHODS = ['GET', 'POST', 'PUT', 'DELETE'];
const NO_STORE = { 'cache-control': 'no-store' };

type HouseholdMeta = {
  household_id: string;
  epoch: number;
  initialized: number;
};

interface SocketAttachment {
  memberId: string;
  role: HouseholdRole;
  tokenHash: string;
}

function nicknameFrom(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const nickname = value.trim();
  return nickname.length > 0 && nickname.length <= 128 ? nickname : undefined;
}

function credentialFrom(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048 ? value : undefined;
}

function methodNotAllowed(method: string, pathname: string, allowed: string[]): Response {
  return Response.json(
    { error: 'method_not_allowed', message: `Method ${method} is not allowed on ${pathname}` },
    { status: 405, headers: { allow: allowed.join(', ') } },
  );
}

export class HouseholdHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => migrateHousehold(ctx.storage));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const { method } = request;

    if (!HUB_METHODS.includes(method)) return methodNotAllowed(method, pathname, HUB_METHODS);

    if (method === 'POST') {
      switch (pathname) {
        case '/api/household/init':
          return this.#bindOwner(request, 'init');
        case '/api/household/owner/recover':
          return this.#bindOwner(request, 'recover');
        case '/api/household/join':
          return this.#join(request);
        case '/api/household/invites':
          return this.#createInvite(request);
        case '/api/sync/ws-ticket':
          return this.#issueTicket(request);
      }
      const revoke = /^\/api\/household\/members\/([^/]+)\/revoke$/.exec(pathname);
      if (revoke) return this.#revoke(request, revoke[1]);
    }

    if (method === 'GET') {
      switch (pathname) {
        case '/api/household/me':
          return this.#me(request);
        case '/api/household/members':
          return this.#members(request);
        case '/api/sync/ws':
          return this.#upgrade(request, url.searchParams.get('ticket'));
      }
    }

    const principal = requireMember(this.ctx.storage.sql, await this.#hashRequest(request));
    return cloudError('code' in principal ? principal : NOT_FOUND);
  }

  async #readPayload(request: Request): Promise<Record<string, unknown> | undefined> {
    if (!request.body || Number(request.headers.get('content-length')) > MAX_AUTH_BODY_BYTES) {
      return undefined;
    }
    const reader = request.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
    let bytes = 0;
    let text = '';
    try {
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        bytes += chunk.value.byteLength;
        if (bytes > MAX_AUTH_BODY_BYTES) {
          await reader.cancel();
          return undefined;
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      const payload: unknown = JSON.parse(text + decoder.decode());
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        return payload as Record<string, unknown>;
      }
    } catch {
      return undefined;
    } finally {
      reader.releaseLock();
    }
  }

  #hashRequest(request: Request): Promise<string | null> {
    return hashBearer(request.headers.get('authorization'));
  }

  #meta(): HouseholdMeta {
    return this.ctx.storage.sql
      .exec<HouseholdMeta>(
        'SELECT household_id, epoch, initialized FROM household_meta WHERE id = 1',
      )
      .one();
  }

  #identity(
    meta: HouseholdMeta,
    id: string,
    role: HouseholdRole,
    nickname: string,
  ): HouseholdIdentity {
    return { householdId: meta.household_id, epoch: meta.epoch, memberId: id, role, nickname };
  }

  #insertMember(
    id: string,
    nickname: string,
    role: HouseholdRole,
    tokenHash: string,
    now: string,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO household_members (id, nickname, role, token_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      nickname,
      role,
      tokenHash,
      now,
      now,
    );
  }

  async #bindOwner(request: Request, action: 'init' | 'recover'): Promise<Response> {
    const { storage } = this.ctx;
    const { sql } = storage;
    const attempts = new AuthAttempts(sql, 'owner', request.headers);
    const blocked = attempts.blocked(Date.now());
    if (blocked) return cloudError(blocked);

    const payload = await this.#readPayload(request);
    if (!payload) return cloudError(VALIDATION_ERROR);
    const nickname = nicknameFrom(payload.nickname);
    if (!nickname && (action === 'init' || payload.nickname !== undefined)) {
      return cloudError(VALIDATION_ERROR);
    }
    const secret = credentialFrom(payload.bootstrapSecret);
    const matches =
      secret !== undefined &&
      (await constantTimeSecretMatches(this.env.OWNER_BOOTSTRAP_SECRET, secret));
    const token = matches ? generateCredential() : '';
    const tokenHash = matches ? await hashCredential(token) : '';

    const result = storage.transactionSync(() => {
      const now = Date.now();
      const blocked = attempts.blocked(now);
      if (blocked) return blocked;
      if (!matches) return attempts.fail(now);
      attempts.clear();

      const meta = this.#meta();
      const timestamp = new Date(now).toISOString();
      if (action === 'init') {
        if (meta.initialized || !nickname) return CONFLICT;
        const id = crypto.randomUUID();
        this.#insertMember(id, nickname, 'OWNER', tokenHash, timestamp);
        sql.exec(
          'UPDATE household_meta SET initialized = 1, updated_at = ? WHERE id = 1',
          timestamp,
        );
        return {
          body: {
            ...this.#identity(meta, id, 'OWNER', nickname),
            token,
          } satisfies HouseholdBinding,
        };
      }

      if (!meta.initialized) return CONFLICT;
      const owner = sql
        .exec<{ id: string; nickname: string; token_hash: string }>(
          `SELECT id, nickname, token_hash FROM household_members WHERE role = 'OWNER' AND status = 'ACTIVE'`,
        )
        .toArray()[0];
      if (!owner) return CONFLICT;
      const name = nickname ?? owner.nickname;
      sql.exec(
        'UPDATE household_members SET token_hash = ?, nickname = ?, updated_at = ? WHERE id = ?',
        tokenHash,
        name,
        timestamp,
        owner.id,
      );
      return {
        body: {
          ...this.#identity(meta, owner.id, 'OWNER', name),
          token,
        } satisfies HouseholdBinding,
        oldTokenHash: owner.token_hash,
      };
    });
    if ('code' in result) return cloudError(result);
    if (result.oldTokenHash) {
      this.#disconnect(result.body.memberId, { tokenHash: result.oldTokenHash });
    }
    return Response.json(result.body, { status: action === 'init' ? 201 : 200, headers: NO_STORE });
  }

  async #me(request: Request): Promise<Response> {
    const member = requireMember(this.ctx.storage.sql, await this.#hashRequest(request));
    if ('code' in member) return cloudError(member);
    return Response.json(this.#identity(this.#meta(), member.id, member.role, member.nickname), {
      headers: NO_STORE,
    });
  }

  async #members(request: Request): Promise<Response> {
    const { sql } = this.ctx.storage;
    const principal = requireMember(sql, await this.#hashRequest(request), 'OWNER');
    if ('code' in principal) return cloudError(principal);
    const members = sql
      .exec<{ [Key in keyof HouseholdMember]: HouseholdMember[Key] }>(
        `SELECT id, nickname, role, status, created_at AS createdAt, revoked_at AS revokedAt
       FROM household_members ORDER BY created_at, id`,
      )
      .toArray();
    return Response.json({ members } satisfies HouseholdMembersResponse, { headers: NO_STORE });
  }

  async #createInvite(request: Request): Promise<Response> {
    const { sql } = this.ctx.storage;
    const inviteCode = generateCredential();
    const [tokenHash, codeHash] = await Promise.all([
      this.#hashRequest(request),
      hashCredential(inviteCode),
    ]);
    const owner = requireMember(sql, tokenHash, 'OWNER');
    if ('code' in owner) return cloudError(owner);
    const now = Date.now();
    const expiresAt = new Date(now + INVITE_TTL_MS).toISOString();
    sql.exec(
      'INSERT INTO household_invites (code_hash, created_by, expires_at, created_at) VALUES (?, ?, ?, ?)',
      codeHash,
      owner.id,
      expiresAt,
      new Date(now).toISOString(),
    );
    return Response.json({ inviteCode, expiresAt } satisfies HouseholdInviteResponse, {
      status: 201,
      headers: NO_STORE,
    });
  }

  async #join(request: Request): Promise<Response> {
    const { storage } = this.ctx;
    const { sql } = storage;
    const attempts = new AuthAttempts(sql, 'join', request.headers);
    const blocked = attempts.blocked(Date.now());
    if (blocked) return cloudError(blocked);

    const payload = await this.#readPayload(request);
    const nickname = nicknameFrom(payload?.nickname);
    if (!nickname) return cloudError(VALIDATION_ERROR);
    const inviteCode = credentialFrom(payload?.inviteCode);
    const codeHash = inviteCode ? await hashCredential(inviteCode) : null;
    const token = generateCredential();
    const tokenHash = await hashCredential(token);

    const result = storage.transactionSync(() => {
      const now = Date.now();
      const blocked = attempts.blocked(now);
      if (blocked) return blocked;
      const invite =
        codeHash &&
        sql
          .exec<{ expires_at: string; used_at: string | null }>(
            'SELECT expires_at, used_at FROM household_invites WHERE code_hash = ?',
            codeHash,
          )
          .toArray()[0];
      if (!invite) return attempts.fail(now);
      const expiry = Date.parse(invite.expires_at);
      if (invite.used_at !== null || !Number.isFinite(expiry) || expiry <= now) return CONFLICT;
      attempts.clear();
      const id = crypto.randomUUID();
      const timestamp = new Date(now).toISOString();
      this.#insertMember(id, nickname, 'MEMBER', tokenHash, timestamp);
      sql.exec(
        'UPDATE household_invites SET used_by_member_id = ?, used_at = ? WHERE code_hash = ?',
        id,
        timestamp,
        codeHash,
      );
      return {
        ...this.#identity(this.#meta(), id, 'MEMBER', nickname),
        token,
      } satisfies HouseholdBinding;
    });
    return 'code' in result
      ? cloudError(result)
      : Response.json(result, { status: 201, headers: NO_STORE });
  }

  async #revoke(request: Request, id: string): Promise<Response> {
    const { storage } = this.ctx;
    const { sql } = storage;
    const tokenHash = await this.#hashRequest(request);
    const result = storage.transactionSync(() => {
      const principal = requireMember(sql, tokenHash, 'OWNER');
      if ('code' in principal) return principal;
      const target = sql
        .exec<{ role: HouseholdRole }>('SELECT role FROM household_members WHERE id = ?', id)
        .toArray()[0];
      if (!target) return NOT_FOUND;
      if (target.role === 'OWNER') return CONFLICT;
      const timestamp = new Date().toISOString();
      sql.exec(
        `UPDATE household_members SET status = 'REVOKED', revoked_at = ?, updated_at = ?
         WHERE id = ? AND status = 'ACTIVE'`,
        timestamp,
        timestamp,
        id,
      );
      return {
        type: 'MEMBER_REVOKED',
        householdId: this.#meta().household_id,
        memberId: id,
      } satisfies MemberRevokedFrame;
    });
    if ('code' in result) return cloudError(result);
    this.#disconnect(id, { frame: result });
    return new Response(null, { status: 204 });
  }

  async #issueTicket(request: Request): Promise<Response> {
    const { sql } = this.ctx.storage;
    const ticket = generateCredential();
    const [tokenHash, ticketHash] = await Promise.all([
      this.#hashRequest(request),
      hashCredential(ticket),
    ]);
    const member = requireMember(sql, tokenHash);
    if ('code' in member) return cloudError(member);

    const now = Date.now();
    const expiresAt = now + WS_TICKET_TTL_MS;
    sql.exec('DELETE FROM ws_tickets WHERE expires_at <= ?', now);
    sql.exec(
      'INSERT INTO ws_tickets (ticket_hash, member_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
      ticketHash,
      member.id,
      tokenHash,
      expiresAt,
      now,
    );
    return Response.json(
      { ticket, expiresAt: new Date(expiresAt).toISOString() } satisfies WebSocketTicketResponse,
      { status: 201, headers: NO_STORE },
    );
  }

  async #upgrade(request: Request, ticket: string | null): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return cloudError(VALIDATION_ERROR);
    }
    if (!ticket || !credentialFrom(ticket)) return cloudError(UNAUTHORIZED);
    const ticketHash = await hashCredential(ticket);
    const { storage } = this.ctx;
    const { sql } = storage;
    const result = storage.transactionSync(() => {
      const now = Date.now();
      sql.exec('DELETE FROM ws_tickets WHERE expires_at <= ?', now);
      const issued = sql
        .exec<{ member_id: string; token_hash: string }>(
          'DELETE FROM ws_tickets WHERE ticket_hash = ? RETURNING member_id, token_hash',
          ticketHash,
        )
        .toArray()[0];
      if (!issued) return UNAUTHORIZED;
      const member = requireMember(sql, issued.token_hash);
      if ('code' in member) return member;
      if (member.id !== issued.member_id) return UNAUTHORIZED;
      return {
        memberId: member.id,
        role: member.role,
        tokenHash: issued.token_hash,
      } satisfies SocketAttachment;
    });
    if ('code' in result) return cloudError(result);
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(result);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    // Sync message handling belongs to VAN-208. Every message still revalidates its session.
    void message;
    const attachment = this.#attachment(socket);
    if (!attachment) {
      this.#closeSocket(socket, 4001, 'UNAUTHORIZED');
      return;
    }
    const member = requireMember(this.ctx.storage.sql, attachment.tokenHash);
    if ('code' in member) {
      if (member.code === 'MEMBER_REVOKED' && member.memberId === attachment.memberId) {
        this.#notifyRevoked(socket, {
          type: 'MEMBER_REVOKED',
          householdId: member.householdId,
          memberId: member.memberId,
        });
      } else {
        this.#closeSocket(socket, 4001, 'UNAUTHORIZED');
      }
      return;
    }
    if (member.id !== attachment.memberId || member.role !== attachment.role) {
      this.#closeSocket(socket, 4001, 'UNAUTHORIZED');
    }
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    if (socket.readyState !== WebSocket.CLOSING || code === 1006) return;
    if (code >= 1000 && code < 5000 && ![1004, 1005, 1015].includes(code)) {
      this.#closeSocket(socket, code, reason);
    } else {
      this.#closeSocket(socket);
    }
  }

  webSocketError(socket: WebSocket): void {
    this.#closeSocket(socket, 1011, 'INTERNAL_ERROR');
  }

  #attachment(socket: WebSocket): SocketAttachment | null {
    return socket.deserializeAttachment() as SocketAttachment | null;
  }

  #disconnect(
    memberId: string,
    reason: { frame: MemberRevokedFrame } | { tokenHash: string },
  ): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.#attachment(socket);
      if (attachment?.memberId !== memberId) continue;
      if ('frame' in reason) this.#notifyRevoked(socket, reason.frame);
      else if (attachment.tokenHash === reason.tokenHash)
        this.#closeSocket(socket, 4001, 'UNAUTHORIZED');
    }
  }

  #notifyRevoked(socket: WebSocket, frame: MemberRevokedFrame): void {
    try {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
    } catch {
      // A disconnect during delivery must not prevent closing the other devices.
    }
    this.#closeSocket(socket, 4003, 'MEMBER_REVOKED');
  }

  #closeSocket(socket: WebSocket, code?: number, reason?: string): void {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) {
      try {
        socket.close(code, reason);
      } catch {
        // The connection can close before the close frame is sent.
      }
    }
  }

  // Image admission and registration share the household's authorization state.
  async preflightImage(
    authorization: string | null,
    request: ImageUploadRequest,
  ): Promise<ImagePreflight> {
    const sql = this.ctx.storage.sql;
    const member = requireMember(sql, await hashBearer(authorization));
    if ('code' in member) return member;

    const epoch = this.#meta().epoch;
    if (request.epoch !== String(epoch)) return EPOCH_MISMATCH;

    const image = parseImageUpload(request);
    if ('code' in image) return image;

    const existing = this.#findImage(image.assetSha256, image.variant);
    if (existing) {
      return existing.content_sha256 === image.contentSha256 ? { kind: 'existing' } : CONFLICT;
    }

    const objectKey = `images/${image.assetSha256}/${image.variant}/${crypto.randomUUID()}`;
    return { kind: 'upload', upload: { ...image, epoch, objectKey } };
  }

  async commitImage(authorization: string | null, image: PendingImageUpload): Promise<ImageCommit> {
    const hash = await hashBearer(authorization);
    const storage = this.ctx.storage;
    return storage.transactionSync(() => {
      const sql = storage.sql;
      const member = requireMember(sql, hash);
      if ('code' in member) return member;
      if (image.epoch !== this.#meta().epoch) return EPOCH_MISMATCH;

      const existing = this.#findImage(image.assetSha256, image.variant);
      if (existing) {
        if (existing.object_key === image.objectKey) return { kind: 'registered' };
        return existing.content_sha256 === image.contentSha256 ? { kind: 'existing' } : CONFLICT;
      }

      sql.exec(
        `INSERT INTO image_objects
          (asset_sha256, variant, object_key, content_sha256, mime_type, size_bytes, epoch, uploaded_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        image.assetSha256,
        image.variant,
        image.objectKey,
        image.contentSha256,
        image.mimeType,
        image.sizeBytes,
        image.epoch,
        member.id,
      );
      return { kind: 'registered' };
    });
  }

  async readImage(authorization: string | null, target: ImageTarget): Promise<ImageRead> {
    const member = requireMember(this.ctx.storage.sql, await hashBearer(authorization));
    if ('code' in member) return member;

    const image = parseImageTarget(target);
    if (!image) return { code: 'VALIDATION_ERROR', status: 400 } satisfies CloudFailure;
    const entry = this.#findImage(image.assetSha256, image.variant);
    return entry ? { kind: 'found', objectKey: entry.object_key } : NOT_FOUND;
  }

  #findImage(assetSha256: string, variant: string) {
    return this.ctx.storage.sql
      .exec<{ content_sha256: string; object_key: string }>(
        'SELECT content_sha256, object_key FROM image_objects WHERE asset_sha256 = ? AND variant = ?',
        assetSha256,
        variant,
      )
      .toArray()[0];
  }
}
