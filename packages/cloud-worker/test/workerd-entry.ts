import { hashBearer, requireMember } from '../src/auth';
import worker, { HouseholdHub as ProductionHouseholdHub, type Env } from '../src/index';
import type { PendingImageUpload } from '../src/image-protocol';
import { migrateHousehold } from '../src/schema';

const testPrefix = '/__test/';
const IMAGE_FETCH_PATH = '/api/sync/images';

// This entry is bundled only by Miniflare. The production Worker has no seed or inspection routes.
export class HouseholdHub extends ProductionHouseholdHub {
  /** 每个真实 DO 实例一个随机值：用于证明 hibernate 驱逐后确实重建了实例。 */
  readonly instanceId: string = crypto.randomUUID();

  override async fetch(request?: Request): Promise<Response> {
    if (!request) return super.fetch(new Request('https://test.invalid/__test/missing'));
    const url = new URL(request.url);
    const { pathname, searchParams } = url;
    const storage = this.ctx.storage;
    const sql = storage.sql;

    // 图片 GET/PUT 由外层 Worker 自行完成授权与流处理。任何图片请求如果还能走到
    // 这里，说明外层又把整条请求转给了 DO fetch；返回显式哨兵让测试断言“外层绕过”。
    if (pathname === IMAGE_FETCH_PATH || pathname.startsWith(`${IMAGE_FETCH_PATH}/`)) {
      return new Response('DO_IMAGE_FETCH', {
        status: 418,
        headers: { 'x-test-image-intercept': `${request.method} ${pathname}${url.search}` },
      });
    }

    switch (pathname) {
      case '/__test/inspect':
        return Response.json({
          schema: sql
            .exec(
              `SELECT type, name, tbl_name, sql FROM sqlite_master
                   WHERE type IN ('table', 'index') AND name NOT GLOB 'sqlite_*' ORDER BY name`,
            )
            .toArray(),
          logIndexes: sql.exec('PRAGMA index_list("sync_log")').toArray(),
          operationKey: sql
            .exec('PRAGMA index_info("sqlite_autoindex_executed_operations_1")')
            .toArray(),
          household: sql
            .exec('SELECT id, household_id, epoch, initialized FROM household_meta')
            .one(),
          instanceId: this.instanceId,
          settings: sql.exec('SELECT id, version FROM "Settings" WHERE id = 1').one(),
          shopping: sql.exec('SELECT id, name, status, version FROM "ShoppingList"').toArray(),
          syncLog: sql.exec('SELECT * FROM sync_log ORDER BY epoch, sync_seq').toArray(),
          images: sql.exec('SELECT * FROM image_objects ORDER BY variant').toArray(),
          members: sql
            .exec(
              `SELECT id, nickname, role, status, revoked_at, token_hash
                 FROM household_members ORDER BY created_at, id`,
            )
            .toArray(),
          invites: sql
            .exec(
              'SELECT code_hash, created_by, expires_at, used_by_member_id FROM household_invites',
            )
            .toArray(),
          tickets: sql
            .exec(
              'SELECT ticket_hash, member_id, token_hash, created_at, expires_at FROM ws_tickets',
            )
            .toArray(),
          attempts: sql
            .exec('SELECT scope, source, failures, expires_at FROM household_auth_attempts')
            .toArray(),
          sockets: this.ctx
            .getWebSockets()
            .map((socket) => socket.deserializeAttachment() as Record<string, unknown> | null),
          // 只暴露计数摘要，不倾倒业务行；验收报告的数据库结论由此得出。
          counts: {
            members: sql.exec('SELECT COUNT(*) AS n FROM household_members').one().n,
            activeMembers: sql
              .exec(`SELECT COUNT(*) AS n FROM household_members WHERE status = 'ACTIVE'`)
              .one().n,
            invites: sql.exec('SELECT COUNT(*) AS n FROM household_invites').one().n,
            tickets: sql.exec('SELECT COUNT(*) AS n FROM ws_tickets').one().n,
            attempts: sql.exec('SELECT COUNT(*) AS n FROM household_auth_attempts').one().n,
            syncLog: sql.exec('SELECT COUNT(*) AS n FROM sync_log').one().n,
            images: sql.exec('SELECT COUNT(*) AS n FROM image_objects').one().n,
          },
        });
      case '/__test/close-sockets': {
        // Direct close with an arbitrary code: used to prove the client never
        // receives a revocation frame on non-revocation disconnects.
        const code = Number(searchParams.get('code') ?? 4001);
        for (const socket of this.ctx.getWebSockets()) {
          socket.close(code, searchParams.get('reason') ?? 'TEST');
        }
        return new Response(null, { status: 204 });
      }
      case '/__test/send-frame': {
        // Delivers a literal frame over every active socket without changing auth state.
        const frame = searchParams.get('frame') ?? '{}';
        let delivered = 0;
        for (const socket of this.ctx.getWebSockets()) {
          socket.send(frame);
          delivered += 1;
        }
        return Response.json({ delivered });
      }
      case '/__test/seed': {
        const { id, tokenHash, role, status } = await request.json<{
          id: string;
          tokenHash: string;
          role: 'OWNER' | 'MEMBER';
          status: 'ACTIVE' | 'REVOKED';
        }>();
        sql.exec(
          `INSERT INTO household_members (id, nickname, token_hash, role, status, updated_at)
           VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT (id) DO UPDATE SET status = excluded.status`,
          id,
          id,
          tokenHash,
          role,
          status,
        );
        return new Response(null, { status: 204 });
      }
      case '/__test/owner': {
        const member = requireMember(
          sql,
          await hashBearer(request.headers.get('authorization')),
          'OWNER',
        );
        if ('code' in member) {
          const body =
            member.code === 'MEMBER_REVOKED'
              ? { code: member.code, householdId: member.householdId, memberId: member.memberId }
              : { code: member.code };
          return Response.json(body, { status: member.status });
        }
        return new Response(null, { status: 204 });
      }
      case '/__test/migrate':
        sql.exec('UPDATE "Settings" SET "version" = 5');
        sql.exec('UPDATE "ShoppingList" SET "version" = 7');
        migrateHousehold(storage);
        return new Response(null, { status: 204 });
      case '/__test/reset-epoch':
        sql.exec('UPDATE household_meta SET epoch = 1');
        return new Response(null, { status: 204 });
      case '/__test/bump-epoch':
        sql.exec('UPDATE household_meta SET epoch = epoch + 1');
        return new Response(null, { status: 204 });
      case '/__test/reset-auth-attempts':
        sql.exec('DELETE FROM household_auth_attempts');
        return new Response(null, { status: 204 });
      case '/__test/expire-tickets':
        // 把票据的过期时间推到过去，模拟 30 秒 TTL 到期（不删除行，仍可验证拒绝路径）。
        sql.exec('UPDATE ws_tickets SET expires_at = ?', Date.now() - 1);
        return new Response(null, { status: 204 });
      case '/__test/seed-sync-log': {
        // 用一行同步日志代表“既有业务数据”，用于恢复/撤权不丢数据的断言。
        sql.exec(
          `INSERT INTO sync_log
             (epoch, sync_seq, entity, entity_id, kind, version, payload_json, actor_member_id, operation_id)
           VALUES (1, 1, 'Ingredient', 'ingredient-1', 'upsert', 2, '{"id":"ingredient-1"}', 'member', 'op-1')`,
        );
        return new Response(null, { status: 204 });
      }
      case '/__test/revoke-without-notifying': {
        const memberId = searchParams.get('memberId');
        sql.exec("UPDATE household_members SET status = 'REVOKED' WHERE id = ?", memberId);
        return new Response(null, { status: 204 });
      }
      case '/__test/clear-images':
        sql.exec('DELETE FROM image_objects');
        return new Response(null, { status: 204 });
      case '/__test/reset-household':
        // Full reset for test isolation: drop the household bootstrap state so
        // init/join flows can be exercised repeatedly inside one harness.
        sql.exec('DELETE FROM ws_tickets');
        sql.exec('DELETE FROM household_auth_attempts');
        sql.exec('DELETE FROM household_invites');
        sql.exec('DELETE FROM household_members');
        sql.exec(
          `UPDATE household_meta
             SET epoch = 1, initialized = 0, household_id = 'default', updated_at = CURRENT_TIMESTAMP
           WHERE id = 1`,
        );
        for (const socket of this.ctx.getWebSockets()) socket.close(4001, 'TEST_RESET');
        return new Response(null, { status: 204 });
      case '/__test/arm':
        await storage.put(`image-hook:${searchParams.get('digest')}`, searchParams.get('action'));
        return new Response(null, { status: 204 });
      case '/__test/hold-commit': {
        // 让下一次 commitImage 停在 R2 写入之后、DO 登记之前，给另一条真实请求
        // （馆主撤权）留出自然的并发窗口。
        await storage.put('commit-gate', 'held');
        return new Response(null, { status: 204 });
      }
      case '/__test/release-commit': {
        await storage.put('commit-gate', 'released');
        return new Response(null, { status: 204 });
      }
      case '/__test/gate-state':
        return Response.json({ state: (await storage.get<string>('commit-gate')) ?? null });
      case '/api/sync/__test_echo':
      case '/api/household/__test_echo':
        return new Response(request.body, {
          headers: {
            'x-test-url': request.url,
            'x-test-method': request.method,
            'x-test-header': request.headers.get('x-test-header') ?? '',
          },
        });
      default:
        return super.fetch(request);
    }
  }

  override async commitImage(authorization: string | null, image: PendingImageUpload) {
    const { storage } = this.ctx;
    const key = `image-hook:${image.assetSha256}`;
    const action = await storage.get<string>(key);
    if (action) {
      await storage.delete(key);
      if (!(await this.env.PRIVATE_BUCKET.head(image.objectKey))) {
        throw new Error('Commit hook expected a completed R2 write');
      }
      if (action === 'revoke') {
        storage.sql.exec(
          `UPDATE household_members SET status = 'REVOKED', revoked_at = CURRENT_TIMESTAMP
           WHERE token_hash = ?`,
          await hashBearer(authorization),
        );
      }
      if (action === 'epoch') {
        storage.sql.exec('UPDATE household_meta SET epoch = epoch + 1');
      }
      if (action === 'error') {
        // Force the real SQL registration to fail inside its transaction.
        storage.sql.exec(`CREATE TRIGGER reject_test_image BEFORE INSERT ON image_objects
          BEGIN SELECT RAISE(ABORT, 'test image registration failure'); END`);
        try {
          return await super.commitImage(authorization, image);
        } finally {
          storage.sql.exec('DROP TRIGGER reject_test_image');
        }
      }
    }
    if ((await storage.get<string>('commit-gate')) === 'held') {
      // 只拦第一次提交：读到就改成 waiting，后续提交（例如馆主并发上传）直接放行。
      await storage.put('commit-gate', 'waiting');
      for (let attempt = 0; attempt < 600; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if ((await storage.get<string>('commit-gate')) === 'released') break;
      }
    }
    return super.commitImage(authorization, image);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith(testPrefix)) {
      const space = env.HOUSEHOLD_HUB;
      return space.get(space.idFromName('default')).fetch(request);
    }

    const fakeLength = request.headers.get('x-test-content-length');
    if (fakeLength && request.body) {
      const headers = new Headers(request.headers);
      headers.delete('x-test-content-length');
      if (fakeLength === 'missing') {
        headers.delete('content-length');
        // workerd 会为已知长度的 body 重新补回 Content-Length；套一层透传流把它变成
        // 未知长度（等价于真实客户端的 chunked 上传），才能验证“缺头部即拒绝”。
        request = new Request(request.url, {
          method: request.method,
          body: request.body.pipeThrough(new TransformStream()),
          headers,
        });
        return worker.fetch(request, env);
      }
      headers.set('content-length', fakeLength);
      request = new Request(request.url, { method: request.method, body: request.body, headers });
    }
    return worker.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;
