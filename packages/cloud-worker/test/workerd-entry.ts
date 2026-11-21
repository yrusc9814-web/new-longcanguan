import { hashBearer, requireMember } from '../src/auth';
import worker, { HouseholdHub as ProductionHouseholdHub, type Env } from '../src/index';
import type { PendingImageUpload } from '../src/image-protocol';
import { migrateHousehold } from '../src/schema';

const testPrefix = '/__test/';

// This entry is bundled only by Miniflare. The production Worker has no seed or inspection routes.
export class HouseholdHub extends ProductionHouseholdHub {
  override async fetch(request?: Request): Promise<Response> {
    if (!request) return super.fetch();
    const { pathname, searchParams } = new URL(request.url);
    const storage = this.ctx.storage;
    const sql = storage.sql;

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
          settings: sql.exec('SELECT id, version FROM "Settings" WHERE id = 1').one(),
          shopping: sql.exec('SELECT id, name, status, version FROM "ShoppingList"').toArray(),
          images: sql.exec('SELECT * FROM image_objects ORDER BY variant').toArray(),
        });
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
        return 'code' in member
          ? Response.json({ code: member.code }, { status: member.status })
          : new Response(null, { status: 204 });
      }
      case '/__test/migrate':
        sql.exec('UPDATE "Settings" SET "version" = 5');
        sql.exec('UPDATE "ShoppingList" SET "version" = 7');
        migrateHousehold(storage);
        return new Response(null, { status: 204 });
      case '/__test/reset-epoch':
        sql.exec('UPDATE household_meta SET epoch = 1');
        return new Response(null, { status: 204 });
      case '/__test/arm':
        await storage.put(`image-hook:${searchParams.get('digest')}`, searchParams.get('action'));
        return new Response(null, { status: 204 });
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
        return super.fetch();
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
      if (fakeLength === 'missing') headers.delete('content-length');
      else headers.set('content-length', fakeLength);
      request = new Request(request.url, { method: request.method, body: request.body, headers });
    }
    return worker.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;
