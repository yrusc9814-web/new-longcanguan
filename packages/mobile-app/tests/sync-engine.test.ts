import { describe, expect, it } from 'vitest';

import { openDatabase, type DatabaseHandle } from '../src/db/database.js';
import { createNodeSqliteDriver } from './helpers/node-sqlite-driver.js';
import {
  createSyncHttpClient,
  EpochMismatchError,
  TrustedRevocationError,
  type SyncFetch,
  type SyncHttpContext,
} from '../src/sync/http.js';
import { isLedgerEmpty, pendingOutbox, readSyncState, tableOrder } from '../src/sync/ledger.js';
import { pushOutbox } from '../src/sync/push.js';
import { pullUntilIdle, rollbackLocalPlan } from '../src/sync/pull.js';
import { downloadSnapshot, uploadInitialSnapshot } from '../src/sync/snapshot.js';
import { createSafetyBackup } from '../src/sync/safety-backup.js';
import { createImageSyncQueue } from '../src/sync/images.js';
import { createMemoryUploadsFiles } from '../src/native/upload-files.js';
import { sha256Hex } from '../src/modules/uploads/codec.js';
import { createSyncEngine } from '../src/sync/engine.js';
import { createMemoryAppSecurity } from '../src/native/app-security.js';
import { readBinding } from '../src/sync/ledger.js';

const NOW = new Date('2026-11-22T00:00:00.000Z');
const EPOCH = 3;

async function db(): Promise<DatabaseHandle> {
  const handle = await openDatabase({
    driver: createNodeSqliteDriver({ path: ':memory:' }),
    now: () => NOW,
  });
  await handle.setEpoch(EPOCH);
  return handle;
}

function context(overrides: Partial<SyncHttpContext> = {}): SyncHttpContext {
  return {
    cloudOrigin: 'https://cloud.example',
    householdId: 'hh',
    memberId: 'm1',
    role: 'MEMBER',
    generation: 2,
    epoch: EPOCH,
    token: 'tok',
    ...overrides,
  };
}

function http(
  fetchImpl: SyncFetch,
  ctx: SyncHttpContext | null = context(),
  onRevoked?: () => void,
) {
  return createSyncHttpClient({ fetch: fetchImpl, context: async () => ctx, onRevoked });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function seedOutboxRow(database: DatabaseHandle, opId: string, entityId = 'r1') {
  await database.withWriteTransaction(async (tx) => {
    await tx.run(
      `INSERT INTO "Recipe" ("id","name","version","createdAt","updatedAt") VALUES (?,?,?,?,?)`,
      [entityId, '番茄炒蛋', 1, NOW.toISOString(), NOW.toISOString()],
    );
    await tx.enqueue({
      opId,
      entity: 'Recipe',
      entityId,
      kind: 'upsert',
      baseVersion: null,
      payload: { id: entityId, name: '番茄炒蛋', version: 1 },
    });
  });
}

describe('push：ack 收敛与幂等重推', () => {
  it('accepted 操作从发件箱删除，未 ack 的保留', async () => {
    const database = await db();
    await seedOutboxRow(database, 'op-1');
    let sent: {
      deviceId?: string;
      wsConnectionId?: string;
      operations?: { id: string; kind: string; baseVersion: number | null }[];
    } | null = null;
    const client = http(async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return json(200, {
        acceptedOperationIds: ['op-1'],
        rejected: [],
        acknowledgements: [{ operationId: 'op-1', ackSeq: 1, newVersion: 1 }],
      });
    });
    const result = await pushOutbox({
      database,
      http: client,
      clientId: 'device-a',
      epoch: EPOCH,
      connectionId: 'conn-1',
    });
    expect(result.accepted).toBe(1);
    expect(sent).toMatchObject({
      deviceId: 'device-a',
      wsConnectionId: 'conn-1',
      operations: [{ id: 'op-1', kind: 'upsert', baseVersion: null }],
    });
    expect(await pendingOutbox(database, EPOCH, 10)).toHaveLength(0);
  });

  it('整批未确认时保留发件箱，重推复用同一 opId', async () => {
    const database = await db();
    await seedOutboxRow(database, 'op-1');
    const seen: string[] = [];
    const client = http(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      seen.push(...body.operations.map((op: { id: string }) => op.id));
      return json(502, { code: 'INTERNAL_ERROR' });
    });
    await expect(
      pushOutbox({ database, http: client, clientId: 'd', epoch: EPOCH }),
    ).rejects.toBeTruthy();
    expect(await pendingOutbox(database, EPOCH, 10)).toHaveLength(1);
    expect(seen).toEqual(['op-1']);
  });
});

describe('pull：零回声与本地未确认保护', () => {
  it('云端行写入 SQLite 时不产生发件箱记录', async () => {
    const database = await db();
    const client = http(async () =>
      json(200, {
        epoch: EPOCH,
        entries: [
          {
            seq: 5,
            operationId: 'remote-op',
            changes: [
              {
                table: 'Recipe',
                id: 'r9',
                row: {
                  id: 'r9',
                  name: '云端菜',
                  version: 1,
                  deletedAt: null,
                  createdAt: NOW.toISOString(),
                  updatedAt: NOW.toISOString(),
                },
              },
            ],
          },
        ],
        nextSeq: 5,
        hasMore: false,
      }),
    );
    await pullUntilIdle({ database, http: client, epoch: EPOCH });
    expect(await pendingOutbox(database, EPOCH, 10)).toHaveLength(0);
    const [row] = await database.query<{ name: string }>(
      'SELECT "name" FROM "Recipe" WHERE "id"=?',
      ['r9'],
    );
    expect(row?.name).toBe('云端菜');
    expect(await readSyncState(database)).toMatchObject({ epoch: EPOCH, lastSeq: 5 });
  });

  it('本地待推实体不被远端行覆盖', async () => {
    const database = await db();
    await seedOutboxRow(database, 'op-local');
    const client = http(async () =>
      json(200, {
        epoch: EPOCH,
        entries: [
          {
            seq: 9,
            operationId: 'remote',
            changes: [
              {
                table: 'Recipe',
                id: 'r1',
                row: { id: 'r1', name: '远端覆盖', version: 1, updatedAt: NOW.toISOString() },
              },
            ],
          },
        ],
        nextSeq: 9,
        hasMore: false,
      }),
    );
    await pullUntilIdle({ database, http: client, epoch: EPOCH });
    const [row] = await database.query<{ name: string }>(
      'SELECT "name" FROM "Recipe" WHERE "id"=?',
      ['r1'],
    );
    expect(row?.name).toBe('番茄炒蛋');
  });
});

describe('快照：原子替换 + 分页 + 补拉', () => {
  it('分页快照整库替换并写入 (epoch,S)，随后补拉增量', async () => {
    const database = await db();
    await database.withWriteTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO "Recipe" ("id","name","version","updatedAt") VALUES ('old','旧',1,?)`,
        [NOW.toISOString()],
      );
    });
    let page = 0;
    const urls: string[] = [];
    const client = http(async (url) => {
      urls.push(url);
      if (url.includes('/api/sync/snapshot')) {
        page += 1;
        if (page === 1) {
          return json(200, {
            epoch: EPOCH,
            seq: 100,
            rows: [
              {
                table: 'Recipe',
                id: 'r2',
                row: { id: 'r2', name: '快照', version: 1, updatedAt: NOW.toISOString() },
              },
            ],
            nextCursor: 'c1',
            isEmpty: false,
          });
        }
        return json(200, { epoch: EPOCH, seq: 100, rows: [], nextCursor: null, isEmpty: true });
      }
      return json(200, {
        epoch: EPOCH,
        entries: [
          {
            seq: 101,
            operationId: 'op-live',
            changes: [
              {
                table: 'Recipe',
                id: 'r3',
                row: { id: 'r3', name: '增量', version: 1, updatedAt: NOW.toISOString() },
              },
            ],
          },
        ],
        nextSeq: 101,
        hasMore: false,
      });
    });
    const result = await downloadSnapshot({ database, http: client, epoch: EPOCH, pageSize: 10 });
    expect(result).toMatchObject({ epoch: EPOCH, seq: 100, rows: 1, caughtUpRows: 1 });
    const rows = await database.query<{ id: string }>('SELECT "id" FROM "Recipe" ORDER BY "id"');
    expect(rows.map((row) => row.id)).toEqual(['r2', 'r3']);
    expect(await readSyncState(database)).toMatchObject({ lastSeq: 101 });
    expect(await pendingOutbox(database, EPOCH, 10)).toHaveLength(0);
    expect(urls[0]).toContain('/api/sync/snapshot?limit=10');
    expect(urls[1]).toContain('cursor=c1');
  });

  it('初始化上传按外键顺序分页并以 finalize 收尾，清空已上传发件箱', async () => {
    const database = await db();
    await seedOutboxRow(database, 'op-1');
    const bodies: {
      page: number;
      finalize: boolean;
      rows: { table: string }[];
    }[] = [];
    const client = http(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return json(200, { epoch: 1, seq: 20, complete: body.finalize === true });
    });
    const result = await uploadInitialSnapshot({
      database,
      http: client,
      epoch: 0,
      headerEpoch: 1,
      pageSize: 2,
      uploadId: 'u1',
    });
    expect(result).toMatchObject({ epoch: 1, seq: 20 });
    expect(bodies.at(-1)?.finalize).toBe(true);
    expect(bodies.map((body) => body.page)).toEqual(bodies.map((_, index) => index));
    const tables = bodies.flatMap((body) => body.rows.map((row: { table: string }) => row.table));
    expect(tables).toContain('Recipe');
    const order = await tableOrder(database);
    expect(order.indexOf('Recipe')).toBeLessThan(order.indexOf('RecipeStep'));
    expect(order.indexOf('Recipe')).toBeLessThan(order.indexOf('RecipeTag'));
    expect(order.indexOf('ShoppingList')).toBeLessThan(order.indexOf('ShoppingListItem'));
    expect(await pendingOutbox(database, 0, 10)).toHaveLength(0);
  });
});

describe('HTTP 可信撤权边界', () => {
  it('匹配代际的 403 MEMBER_REVOKED 触发 onRevoked 并抛专用错误', async () => {
    let revoked = 0;
    const client = http(
      async () => json(403, { code: 'MEMBER_REVOKED', householdId: 'hh', memberId: 'm1' }),
      context(),
      () => {
        revoked += 1;
      },
    );
    await expect(client.request('/api/sync/pull')).rejects.toBeInstanceOf(TrustedRevocationError);
    expect(revoked).toBe(1);
  });

  it('旧代际迟到撤权、401、403 FORBIDDEN、429、5xx 均不清退', async () => {
    // 旧代际：请求发起时 generation=1，响应到达前已推进到 2。
    {
      let revoked = 0;
      let generation = 1;
      const client = createSyncHttpClient({
        fetch: async () => json(403, { code: 'MEMBER_REVOKED', householdId: 'hh', memberId: 'm1' }),
        context: async () => context({ generation }),
        onRevoked: () => {
          revoked += 1;
        },
      });
      const pending = client.request('/api/sync/push');
      generation = 2; // 响应前换绑
      await expect(pending).rejects.toBeTruthy();
      expect(revoked).toBe(0);
    }

    const cases: Response[] = [
      json(401, { code: 'UNAUTHORIZED' }),
      json(403, { code: 'FORBIDDEN' }),
      json(429, { code: 'RATE_LIMITED' }),
      json(500, { code: 'INTERNAL_ERROR' }),
      json(403, { code: 'MEMBER_REVOKED', householdId: 'other', memberId: 'm1' }),
    ];
    for (const response of cases) {
      let revoked = 0;
      const client = http(
        async () => response.clone(),
        context(),
        () => {
          revoked += 1;
        },
      );
      await expect(client.request('/api/sync/push')).rejects.toBeTruthy();
      expect(revoked).toBe(0);
    }
  });

  it('429 暴露 retryAfter，EPOCH_MISMATCH 暴露 currentEpoch', async () => {
    const limited = http(
      async () =>
        new Response(JSON.stringify({ code: 'RATE_LIMITED' }), {
          status: 429,
          headers: { 'retry-after': '7' },
        }),
    );
    await expect(limited.request('/api/sync/push')).rejects.toMatchObject({ retryAfterMs: 7000 });

    const mismatch = http(async () => json(409, { code: 'EPOCH_MISMATCH', currentEpoch: 9 }));
    const error: unknown = await mismatch.request('/api/sync/push').catch((value) => value);
    expect(error).toBeInstanceOf(EpochMismatchError);
    expect((error as EpochMismatchError).currentEpoch).toBe(9);
  });

  it('跨源重定向一律拒绝，且不跟随到其他源', async () => {
    const client = http(
      async () =>
        new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } }),
    );
    await expect(client.request('/api/sync/pull')).rejects.toThrow('重定向');
  });

  it('非绑定源地址被拒绝（同源校验在发请求前）', async () => {
    let called = 0;
    const client = http(async () => {
      called += 1;
      return json(200, {});
    });
    await expect(client.request('https://evil.example/api/sync/pull')).rejects.toThrow('非法');
    expect(called).toBe(0);
  });
});

describe('空库判定与安全备份', () => {
  it('默认 Settings + 空默认购物清单视为空库；写入业务行后非空', async () => {
    const database = await db();
    await database.withWriteTransaction(async (tx) => {
      await tx.run(`INSERT INTO "Settings" ("id","version","updatedAt") VALUES (1,1,?)`, [
        NOW.toISOString(),
      ]);
      await tx.run(
        `INSERT INTO "ShoppingList" ("id","name","status","version","updatedAt") VALUES (?,?, 'ACTIVE',1,?)`,
        ['shopping_list_active_default', '购物清单', NOW.toISOString()],
      );
    });
    expect(await isLedgerEmpty(database)).toBe(true);
    await database.withWriteTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO "Diner" ("id","name","version","updatedAt") VALUES ('d1','小明',1,?)`,
        [NOW.toISOString()],
      );
    });
    expect(await isLedgerEmpty(database)).toBe(false);
  });

  it('安全备份包含 27 表与待同步操作，并可通过 ZIP 解包', async () => {
    const database = await db();
    await seedOutboxRow(database, 'op-1');
    const backup = await createSafetyBackup({
      database,
      fromEpoch: 2,
      toEpoch: 3,
      now: () => NOW,
    });
    expect(backup.manifest).toMatchObject({ kind: 'epoch-safety', fromEpoch: 2, toEpoch: 3 });
    expect(backup.manifest.tables).toHaveLength(27);
    const { unzipSync } = await import('fflate');
    const entries = unzipSync(backup.bytes);
    const pending = JSON.parse(new TextDecoder().decode(entries['sync/pending.json']));
    expect(pending).toHaveLength(1);
    expect(pending[0].opId).toBe('op-1');
  });
});

describe('冲突回滚', () => {
  it('排餐槽位冲突回滚本地计划与子行', async () => {
    const database = await db();
    await database.withWriteTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO "MealPlan" ("id","planDate","mealType","version","updatedAt") VALUES ('p1','2026-11-22','DINNER',1,?)`,
        [NOW.toISOString()],
      );
      await tx.run(
        `INSERT INTO "MealPlanItem" ("id","mealPlanId","itemType","sortOrder","updatedAt") VALUES ('i1','p1','CUSTOM',0,?)`,
        [NOW.toISOString()],
      );
      await tx.enqueue({
        opId: 'op-plan',
        entity: 'MealPlan',
        entityId: 'p1',
        kind: 'upsert',
        baseVersion: null,
        payload: { id: 'p1' },
      });
    });
    await rollbackLocalPlan(database, 'p1');
    expect(await database.query('SELECT "id" FROM "MealPlan" WHERE "id"=?', ['p1'])).toHaveLength(
      0,
    );
    expect(await database.query('SELECT "id" FROM "MealPlanItem"')).toHaveLength(0);
    expect(await pendingOutbox(database, EPOCH, 10)).toHaveLength(0);
  });
});

describe('图片静默队列', () => {
  it('主图/缩略图去重上传，缺文件时计为失败', async () => {
    const files = createMemoryUploadsFiles();
    const main = new Uint8Array([1, 2, 3, 4]);
    const thumb = new Uint8Array([9, 9]);
    await files.writeFile({ path: 'main-a.webp', data: main });
    await files.writeFile({ path: 'thumb-a.webp', data: thumb });
    const sha = await sha256Hex(main);
    const puts: string[] = [];
    const client = http(async (url, init) => {
      puts.push(`${init?.method} ${new URL(url).pathname}${new URL(url).search}`);
      return new Response(null, { status: 204 });
    });
    const queue = createImageSyncQueue({ http: client, files });
    queue.enqueueUpload({ sha256: sha, storagePath: 'main-a.webp', thumbnailPath: 'thumb-a.webp' });
    queue.enqueueUpload({ sha256: sha, storagePath: 'main-a.webp', thumbnailPath: 'thumb-a.webp' });
    expect(queue.pending).toBe(2);
    const result = await queue.drain();
    expect(result).toMatchObject({ uploaded: 2, failed: 0 });
    expect(puts.sort()).toEqual([
      'PUT /api/sync/images/' + sha + '?variant=main',
      'PUT /api/sync/images/' + sha + '?variant=thumb',
    ]);
  });
});

function noopTimers() {
  const handles: unknown[] = [];
  return {
    delivered: handles,
    setTimeout: (cb: () => void) => {
      handles.push(cb);
      return handles.length;
    },
    clearTimeout: () => undefined,
  };
}

async function boundEngine(
  database: DatabaseHandle,
  fetchImpl: SyncFetch,
  overrides: Partial<Parameters<typeof createSyncEngine>[0]> = {},
  options: { readonly bind?: boolean } = {},
) {
  const security = createMemoryAppSecurity(() => NOW.getTime());
  await security.setMemberToken({ memberToken: 'tok' });
  if (options.bind !== false) {
    await database.withWriteTransaction(async (tx) => {
      await tx.run(
        `UPDATE "device_local_config"
            SET "cloudOrigin" = 'https://cloud.example', "householdId" = 'hh',
                "memberId" = 'm1', "role" = 'MEMBER'
          WHERE "id" = 1`,
      );
    });
  }
  const events: { name: string; detail: unknown }[] = [];
  const stored: string[] = [];
  const engine = createSyncEngine({
    getDatabase: async () => database,
    security,
    fetch: fetchImpl,
    files: createMemoryUploadsFiles(),
    events: (name, detail) => events.push({ name, detail }),
    now: () => NOW,
    timers: noopTimers(),
    socketFactory: () => ({
      readyState: 0,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: () => undefined,
      close: () => undefined,
    }),
    deviceId: () => 'device-test',
    safetyBackupStore: {
      async write(backup) {
        stored.push(backup.name);
        return `safety-backups/${backup.name}`;
      },
    },
    ...overrides,
  });
  return { engine, security, events, stored };
}

describe('engine：绑定与代际切换', () => {
  it('本地非空加入家庭必须先确认，且不写绑定', async () => {
    const database = await db();
    await database.withWriteTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO "Diner" ("id","name","version","updatedAt") VALUES ('d1','小明',1,?)`,
        [NOW.toISOString()],
      );
    });
    const { engine, security } = await boundEngine(
      database,
      async () => json(200, {}),
      {},
      { bind: false },
    );
    await expect(
      engine.join({ inviteCode: 'invite', nickname: '小王' }, { origin: 'https://cloud.example' }),
    ).rejects.toMatchObject({ code: 'REQUIRES_LOCAL_BACKUP_CONFIRMATION' });
    expect(await security.getMemberToken()).toEqual({ memberToken: 'tok' });
    expect(await readBinding(database)).toBeNull();
  });

  it('馆主换机非空先确认，确认后补齐超过一批的快照和增量图片', async () => {
    const database = await db();
    await seedOutboxRow(database, 'local-recipe');
    const files = createMemoryUploadsFiles();
    const sample = (index: number) => new Uint8Array([1, 2, index]);
    const digests = await Promise.all(
      Array.from({ length: 18 }, (_, index) => sha256Hex(sample(index))),
    );
    let cloudCalls = 0;
    const asset = (index: number) => ({
      table: 'UploadAsset',
      id: `asset-${index}`,
      row: {
        id: `asset-${index}`,
        filename: `${index}.webp`,
        storagePath: `${index}.webp`,
        thumbnailPath: `${index}-thumb.webp`,
        sha256: digests[index],
        mimeType: 'image/webp',
        sizeBytes: 3,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
    });
    const { engine } = await boundEngine(
      database,
      async (url) => {
        cloudCalls++;
        const path = new URL(url).pathname;
        if (path === '/api/household/owner/recover') {
          return json(200, {
            householdId: 'hh',
            memberId: 'owner',
            role: 'OWNER',
            epoch: EPOCH,
            token: 'fixture',
          });
        }
        if (path === '/api/sync/snapshot') {
          return json(200, {
            epoch: EPOCH,
            seq: 1,
            rows: Array.from({ length: 17 }, (_, i) => asset(i)),
            nextCursor: null,
          });
        }
        if (path === '/api/sync/pull') {
          return json(200, {
            epoch: EPOCH,
            entries: [{ seq: 2, changes: [asset(17)] }],
            nextSeq: 2,
            hasMore: false,
          });
        }
        const index = digests.indexOf(path.split('/').at(-1) ?? '');
        if (index < 0) throw new Error('unexpected sync request');
        return new Response(sample(index), { headers: { 'x-content-sha256': digests[index]! } });
      },
      { files },
      { bind: false },
    );
    const body = { bootstrapSecret: 'fixture' };
    const options = { origin: 'https://cloud.example' };
    await expect(engine.recoverOwner(body, options)).rejects.toMatchObject({
      code: 'REQUIRES_LOCAL_BACKUP_CONFIRMATION',
    });
    expect(cloudCalls).toBe(0);
    await engine.recoverOwner(body, { ...options, confirmOverwriteLocal: true });
    await expect
      .poll(async () => (await files.listFiles({})).paths.length, { timeout: 5000 })
      .toBe(36);
    expect(await engine.status()).toMatchObject({ phase: 'ok', epoch: EPOCH, lastSeq: 2 });
    await database.close();
  });

  it('EPOCH_RESET：旧代际有待同步数据时先落安全备份，再切快照并清空发件箱', async () => {
    const database = await db();
    await seedOutboxRow(database, 'op-old');
    const { engine, stored, events } = await boundEngine(database, async (url) => {
      if (url.includes('/api/sync/snapshot')) {
        return json(200, {
          epoch: 4,
          seq: 50,
          rows: [
            {
              table: 'Recipe',
              id: 'r1',
              row: {
                id: 'r1',
                name: '新代际',
                version: 2,
                updatedAt: NOW.toISOString(),
              },
            },
          ],
          nextCursor: null,
          isEmpty: false,
        });
      }
      return json(200, { epoch: 4, entries: [], nextSeq: 50, hasMore: false });
    });

    await engine.handleEpochReset(4);

    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatch(/dafan-epoch-3-to-4/);
    expect(await readSyncState(database)).toMatchObject({ epoch: 4, lastSeq: 50 });
    expect(await pendingOutbox(database, 4, 10)).toHaveLength(0);
    expect(events.some((event) => event.name === 'dafan:sync:epoch-reset')).toBe(true);
  });

  it('可信 MEMBER_REVOKED 让引擎停机并调用注入的 onRevoked；429 只退避不清退', async () => {
    const database = await db();
    const revocations: string[] = [];
    const { engine } = await boundEngine(
      database,
      async (url) => {
        if (url.includes('/api/sync/ws-ticket')) return json(401, { code: 'UNAUTHORIZED' });
        return json(403, { code: 'MEMBER_REVOKED', householdId: 'hh', memberId: 'm1' });
      },
      { onRevoked: (evidence) => void revocations.push(evidence.memberId) },
    );
    await engine.syncOnce();
    expect(revocations).toEqual(['m1']);
    expect((await engine.status()).phase).toBe('revoked');

    const limited = await boundEngine(database, async (url) =>
      url.includes('/api/sync/ws-ticket')
        ? json(401, { code: 'UNAUTHORIZED' })
        : json(429, { code: 'RATE_LIMITED' }),
    );
    await limited.engine.syncOnce();
    expect((await limited.engine.status()).phase).toBe('error');
    expect(revocations).toEqual(['m1']);
  });
});
