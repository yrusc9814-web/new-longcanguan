import {
  SHOPPING_DEFAULT_LIST_ID,
  SYNC_SNAPSHOT_TABLES,
  type SyncPullPage,
  type SyncSnapshotPage,
} from '@dafan/shared/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startWorkerd, type WorkerdHarness } from '../../cloud-worker/test/run-workerd';
import {
  BOOTSTRAP_SECRET,
  digest,
  invite,
  ORIGIN,
  revoke,
} from '../../cloud-worker/test/household-support';
import { openDatabase, type DatabaseHandle } from '../src/db/database';
import { registerDomainRoutes } from '../src/local-api/domains';
import { createLocalApiRouter } from '../src/local-api/router';
import { exportBackup } from '../src/modules/backup/service';
import { createMemoryAppSecurity } from '../src/native/app-security';
import { createMemoryUploadsFiles } from '../src/native/upload-files';
import { createSyncEngine } from '../src/sync/engine';
import type { SocketLike } from '../src/sync/ws';
import { unzipSync } from 'fflate';
import { createNodeSqliteDriver } from './helpers/node-sqlite-driver';

let runtime: WorkerdHarness;
const devices: Awaited<ReturnType<typeof makeDevice>>[] = [];
const pollOptions = { timeout: 10_000 };

async function makeDevice(name: string) {
  const database = await openDatabase({ driver: createNodeSqliteDriver({ path: ':memory:' }) });
  const security = createMemoryAppSecurity();
  const files = createMemoryUploadsFiles();
  const events: { name: string; detail: unknown }[] = [];
  const requests: { path: string; status: number }[] = [];
  const backups: Uint8Array[] = [];
  const revocations: { memberId: string; source: string }[] = [];
  const socketFrames: string[] = [];
  const actualSockets: WebSocket[] = [];
  const { port } = new URL((await runtime.mf.ready).href);
  let intercept: ((url: URL, response: Response, init?: RequestInit) => Promise<void>) | undefined;
  const fetchCloud = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const response = await runtime.dispatchFetch(input, init);
    requests.push({ path: url.pathname, status: response.status });
    await intercept?.(url, response, init);
    return response;
  };
  const engine = createSyncEngine({
    getDatabase: async () => database,
    security,
    files,
    fetch: fetchCloud,
    events: (type, detail) => events.push({ name: type, detail }),
    onRevoked: ({ memberId, source }) => {
      revocations.push({ memberId, source });
    },
    deviceId: () => name,
    snapshotPageSize: 1,
    safetyBackupStore: {
      async write(backup) {
        await files.writeFile({ path: `safety-backups/${backup.name}`, data: backup.bytes });
        backups.push(backup.bytes);
        return backup.name;
      },
    },
    socketFactory(cloudUrl) {
      const url = new URL(cloudUrl);
      const actual = new WebSocket(`ws://127.0.0.1:${port}${url.pathname}${url.search}`);
      actualSockets.push(actual);
      const socket: SocketLike = {
        get readyState() {
          return actual.readyState;
        },
        onmessage: null,
        onclose: null,
        onerror: null,
        send: (data) => actual.send(data),
        close: (code, reason) => actual.close(code, reason),
      };
      actual.addEventListener('message', (event) => {
        socketFrames.push(String(event.data));
        socket.onmessage?.(event);
      });
      actual.addEventListener('close', (event) => socket.onclose?.(event));
      actual.addEventListener('error', (event) => socket.onerror?.(event));
      return socket;
    },
  });
  const router = createLocalApiRouter({
    readGateState: () => ({ pinRequired: false, pendingWipe: false }),
  });
  registerDomainRoutes(router, async () => database, undefined, engine);
  async function local<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await router.handle(
      new Request(`https://localhost/api/v1${path}`, {
        method,
        ...(body === undefined
          ? {}
          : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      }),
    );
    const result = await response.json();
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result.data as T;
  }
  async function token() {
    const { memberToken } = await security.getMemberToken();
    if (!memberToken) throw new Error('device is unbound');
    return memberToken;
  }
  await local('/settings');
  await local('/shopping-lists?status=ACTIVE');
  const device = {
    database,
    engine,
    events,
    files,
    local,
    requests,
    token,
    backups,
    revocations,
    socketFrames,
    actualSockets,
    intercept(callback: typeof intercept) {
      intercept = callback;
    },
    async restore(blob: Blob, grant?: string) {
      const data = new FormData();
      data.set('file', blob, 'restore.zip');
      return router.handle(
        new Request('https://localhost/api/v1/backups/restore', {
          method: 'POST',
          body: data,
          headers: grant ? { 'X-High-Risk-Token': grant } : undefined,
        }),
      );
    },
    async addPhoto(label: string) {
      const main = new TextEncoder().encode(`RIFF\0WEBP\0${label}-main`);
      const thumb = new TextEncoder().encode(`RIFF\0WEBP\0${label}-thumb`);
      const asset = {
        sha256: digest(main),
        storagePath: `${label}.webp`,
        thumbnailPath: `${label}-thumb.webp`,
      };
      await files.writeFile({ path: asset.storagePath, data: main });
      await files.writeFile({ path: asset.thumbnailPath, data: thumb });
      const stamp = new Date().toISOString();
      const payload = {
        id: label,
        filename: asset.storagePath,
        ...asset,
        mimeType: 'image/webp',
        sizeBytes: main.byteLength,
        createdAt: stamp,
        updatedAt: stamp,
      };
      await database.withWriteTransaction(async (tx) => {
        await tx.run(
          `INSERT INTO UploadAsset (id, filename, storagePath, thumbnailPath, mimeType, sizeBytes, sha256, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            payload.id,
            payload.filename,
            asset.storagePath,
            asset.thumbnailPath,
            payload.mimeType,
            payload.sizeBytes,
            asset.sha256,
            stamp,
            stamp,
          ],
        );
        await tx.enqueue({
          opId: `${label}-upload`,
          entity: 'UploadAsset',
          entityId: label,
          kind: 'upsert',
          baseVersion: null,
          payload,
        });
      });
      return { main, thumb, asset };
    },
    async journal(epoch: number, after = 0) {
      return runtime.dispatchFetch(`${ORIGIN}/api/sync/pull?after=${after}`, {
        headers: {
          authorization: `Bearer ${await token()}`,
          'x-household-epoch': String(epoch),
        },
      });
    },
    async bindMember(ownerToken: string, confirmOverwriteLocal = false) {
      const { inviteCode } = await invite(runtime, ownerToken);
      return engine.join({ inviteCode, nickname: name }, { origin: ORIGIN, confirmOverwriteLocal });
    },
    async readySocket() {
      await expect
        .poll(() => socketFrames.some((frame) => frame.includes('SYNC_CONNECTED')), pollOptions)
        .toBe(true);
    },
  };
  return device;
}

async function addDevice(name: string) {
  const device = await makeDevice(name);
  devices.push(device);
  return device;
}

async function rows(database: DatabaseHandle, table: string) {
  return database.query<Record<string, unknown>>(`SELECT * FROM "${table}" ORDER BY "id"`);
}

async function noOutbox(database: DatabaseHandle) {
  expect(await database.query('SELECT opId FROM sync_outbox')).toEqual([]);
}

const shopping = `/shopping-lists/${SHOPPING_DEFAULT_LIST_ID}`;

beforeAll(async () => {
  runtime = await startWorkerd(
    new URL('../../cloud-worker/test/workerd-entry.ts', import.meta.url),
    {
      bindings: { OWNER_BOOTSTRAP_SECRET: BOOTSTRAP_SECRET },
    },
  );
}, 30_000);

afterAll(async () => {
  for (const { engine } of devices) engine.stop();
  try {
    await Promise.all(
      devices.flatMap(({ actualSockets }) =>
        actualSockets.map(async (socket) => {
          if (socket.readyState === WebSocket.CLOSED) return;
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('WebSocket did not close')), 15_000);
            socket.addEventListener(
              'close',
              () => {
                clearTimeout(timeout);
                resolve();
              },
              { once: true },
            );
            socket.close();
          });
        }),
      ),
    );
  } finally {
    await Promise.all(devices.map(({ database }) => database.close()));
    await runtime?.dispose();
  }
}, 25_000);

describe('mobile SQLite and HouseholdHub on Miniflare', () => {
  let owner: Awaited<ReturnType<typeof makeDevice>>;
  let member: Awaited<ReturnType<typeof makeDevice>>;

  it('initializes offline data, anchors snapshot pages and immediately fills the concurrent gap', async () => {
    owner = await addDevice('owner');
    const offlinePhoto = await owner.addPhoto('offline-photo');
    await owner.local(`${shopping}/items`, 'POST', { ingredientName: '离线米饭', version: 1 });
    let interrupted = false;
    owner.intercept(async (url, response, request) => {
      if (url.pathname !== '/api/sync/init-upload' || response.status !== 200 || interrupted)
        return;
      if (JSON.parse(String(request?.body)).page !== 1) return;
      interrupted = true;
      throw new TypeError('simulated network disconnect after accepting the page');
    });
    const init = await owner.engine.initOwner(
      { bootstrapSecret: BOOTSTRAP_SECRET, nickname: '馆主' },
      { origin: ORIGIN },
    );
    expect(init.initialized).toBe(false);
    expect((await owner.engine.status()).epoch).toBe(0);
    expect(await rows(owner.database, 'ShoppingListItem')).toMatchObject([
      { ingredientNameSnapshot: '离线米饭' },
    ]);
    expect(await owner.database.query('SELECT page FROM sync_init_pages')).not.toEqual([]);
    await owner.engine.handleEpochReset(1);
    expect(await rows(owner.database, 'ShoppingListItem')).toHaveLength(1);
    const current = await owner.local<{ version: number }>(shopping);
    await owner.local(`${shopping}/items`, 'POST', {
      ingredientName: '断网后加购',
      version: current.version,
    });
    owner.intercept(undefined);
    await owner.engine.syncOnce();
    expect(await owner.engine.status()).toMatchObject({ epoch: 1, phase: 'ok' });
    expect(await owner.database.query('SELECT page FROM sync_init_pages')).toEqual([]);
    await noOutbox(owner.database);
    const ownerToken = await owner.token();
    member = await addDevice('member');
    await member.local(`${shopping}/items`, 'POST', { ingredientName: '本地面条', version: 1 });
    await expect(member.bindMember(ownerToken)).rejects.toMatchObject({
      code: 'REQUIRES_LOCAL_BACKUP_CONFIRMATION',
    });
    expect(await rows(member.database, 'ShoppingListItem')).toMatchObject([
      { ingredientNameSnapshot: '本地面条' },
    ]);
    let anchor: SyncSnapshotPage | undefined;
    member.intercept(async (url, response) => {
      if (url.pathname !== '/api/sync/snapshot' || anchor) return;
      anchor = (await response.clone().json()) as SyncSnapshotPage;
      expect(anchor.nextCursor).toBeTruthy();
      const current = await owner.local<{ version: number }>(shopping);
      await owner.local(`${shopping}/items`, 'POST', {
        ingredientName: '分页期间加购',
        version: current.version,
      });
      owner.engine.start();
      await owner.engine.wake();
    });
    await member.bindMember(ownerToken, true);
    await member.engine.pullNow();
    expect(await member.files.readFile({ path: offlinePhoto.asset.storagePath })).toEqual({
      data: offlinePhoto.main,
    });
    expect(await member.files.readFile({ path: offlinePhoto.asset.thumbnailPath })).toEqual({
      data: offlinePhoto.thumb,
    });
    expect(anchor?.epoch).toBe(1);
    const page = await member.journal(1, anchor?.seq);
    expect(((await page.json()) as SyncPullPage).entries.length).toBeGreaterThan(0);
    expect(
      (await rows(member.database, 'ShoppingListItem'))
        .map((row) => row.ingredientNameSnapshot)
        .sort(),
    ).toEqual(['分页期间加购', '断网后加购', '离线米饭'].sort());
    await noOutbox(member.database);

    for (const table of SYNC_SNAPSHOT_TABLES) {
      expect(await rows(member.database, table), table).toEqual(await rows(owner.database, table));
    }
  }, 25_000);

  it('merges offline shopping changes, removes the losing plan, and rolls back excess inventory', async () => {
    owner.engine.stop();
    member.engine.stop();
    const { version, items } = await owner.local<{ version: number; items: { id: string }[] }>(
      shopping,
    );
    await owner.local(`/shopping-list-items/${items[0]!.id}`, 'PUT', { version, completed: true });
    await member.local(`${shopping}/items`, 'POST', { version, ingredientName: '番茄' });
    owner.engine.start();
    await owner.engine.wake();
    member.engine.start();
    await member.engine.wake();
    await owner.engine.pullNow();
    expect(
      member.requests.filter(({ path, status }) => path === '/api/sync/push' && status === 409),
    ).toEqual([]);
    expect(await rows(owner.database, 'ShoppingList')).toMatchObject([
      { id: SHOPPING_DEFAULT_LIST_ID },
    ]);
    expect(await rows(owner.database, 'ShoppingListItem')).toEqual(
      await rows(member.database, 'ShoppingListItem'),
    );
    expect(await rows(owner.database, 'ShoppingListItem')).toHaveLength(4);
    expect(
      (await rows(owner.database, 'ShoppingListItem')).find(({ id }) => id === items[0]!.id)
        ?.completed,
    ).toBe(1);

    owner.engine.stop();
    member.engine.stop();
    const plan = {
      planDate: '2026-12-06',
      mealType: 'LUNCH',
      dinerCount: 2,
      items: [{ itemType: 'CUSTOM', customName: '米饭' }],
    };
    const winning = await owner.local<{ id: string }>('/plans', 'POST', {
      ...plan,
      title: '馆主排餐',
    });
    const losing = await member.local<{ id: string }>('/plans', 'POST', {
      ...plan,
      title: '成员排餐',
    });
    const eggs = await owner.local<{ id: string }>('/ingredients', 'POST', {
      name: '鸡蛋',
      unit: 'PIECE',
      batches: [{ quantity: 3, unit: 'PIECE' }],
    });
    owner.engine.start();
    await owner.engine.wake();
    member.engine.start();
    await member.engine.wake();
    expect(
      member.events.find(({ name }) => name === 'dafan:sync:plan-slot-conflict')?.detail,
    ).toMatchObject({ planId: losing.id, winner: { id: winning.id } });
    expect(await rows(member.database, 'MealPlan')).toMatchObject([
      { id: winning.id, title: '馆主排餐' },
    ]);
    expect(await rows(member.database, 'MealPlanItem')).toEqual(
      await rows(owner.database, 'MealPlanItem'),
    );

    owner.engine.stop();
    member.engine.stop();
    for (const device of [owner, member]) {
      await device.local(`/ingredients/${eggs.id}/consume`, 'POST', {
        mode: 'QUANTITY',
        quantity: 2,
        unit: 'PIECE',
        ingredientVersion: 1,
      });
    }
    expect(
      await owner.database.query('SELECT opId, commandType, epoch FROM sync_outbox'),
    ).toMatchObject([{ commandType: 'INGREDIENT_CONSUME', epoch: 1 }]);
    let acknowledged: unknown;
    let rejection: string | undefined;
    owner.intercept(async (url, response, init) => {
      if (url.pathname !== '/api/sync/push') return;
      if (!response.ok) {
        rejection = `${response.status}: ${await response.clone().text()}`;
        return;
      }
      const ack = await response.clone().json();
      if (acknowledged === undefined) {
        acknowledged = ack;
        const retry = await runtime.dispatchFetch(url.href, init);
        expect(await retry.json()).toEqual(acknowledged);
      }
    });
    owner.engine.start();
    await owner.engine.wake();
    owner.intercept(undefined);
    expect(
      acknowledged,
      rejection ?? JSON.stringify(await owner.engine.status()),
    ).not.toBeUndefined();
    member.engine.start();
    await member.engine.wake();
    expect(
      member.events.find(({ name }) => name === 'dafan:sync:ingredient-conflict')?.detail,
    ).toMatchObject({ ingredientId: eggs.id });
    for (const table of ['Ingredient', 'InventoryBatch', 'InventoryLog']) {
      expect(await rows(member.database, table)).toEqual(await rows(owner.database, table));
    }
    expect(await rows(member.database, 'Ingredient')).toMatchObject([{ id: eggs.id, quantity: 1 }]);
    await noOutbox(owner.database);
    await noOutbox(member.database);
  }, 25_000);

  it('replays the remaining atomic commands in both directions with aligned row IDs', async () => {
    const synchronize = async (source: typeof owner, target: typeof member, tables: string[]) => {
      await source.engine.syncOnce();
      await target.engine.pullNow();
      await noOutbox(source.database);
      await noOutbox(target.database);
      for (const table of tables) {
        expect(await rows(source.database, table), table).toEqual(
          await rows(target.database, table),
        );
      }
    };
    owner.engine.stop();
    member.engine.stop();
    const plan = await member.local<{ id: string }>('/plans', 'POST', {
      planDate: '2026-12-07',
      dinerCount: 1,
      mealType: 'LUNCH',
      items: [{ itemType: 'CUSTOM', customName: '炒饭' }],
    });
    const mealTables = [
      'MealPlan',
      'MealPlanItem',
      'MealPlanDiner',
      'MealRecord',
      'MealRecordItem',
      'MealRecordDiner',
    ];
    await synchronize(member, owner, mealTables);
    await member.local(`/plans/${plan.id}/complete`, 'POST', { version: 1 });
    await synchronize(member, owner, mealTables);
    expect(await rows(owner.database, 'MealRecord')).toHaveLength(1);
    await owner.local(`/plans/${plan.id}/uncomplete`, 'POST', { version: 2 });
    await synchronize(owner, member, mealTables);

    const recipe = await owner.local<{ id: string }>('/recipes', 'POST', { name: '测试番茄汤' });
    const { record } = await owner.local<{ record: { id: string; version: number } }>(
      `/recipes/${recipe.id}/cook-checkin`,
      'POST',
      { recordDate: '2026-12-07', mealType: 'DINNER' },
    );
    await synchronize(owner, member, [...mealTables, 'Recipe']);
    await member.local(`/records/${record.id}?version=${record.version}`, 'DELETE');
    await synchronize(member, owner, mealTables);
    expect(
      (await rows(owner.database, 'MealRecord')).find(({ id }) => id === record.id)?.deletedAt,
    ).toBeTruthy();

    const stockTables = ['Ingredient', 'InventoryBatch', 'InventoryLog'];
    const flour = await owner.local<{ id: string }>('/ingredients', 'POST', {
      name: '联调面粉',
      unit: 'GRAM',
      batches: [{ quantity: 1000, unit: 'GRAM' }],
    });
    await synchronize(owner, member, stockTables);
    await member.local(`/ingredients/${flour.id}`, 'PUT', {
      name: '联调面粉',
      version: 1,
      unit: 'GRAM',
      quantity: 1300,
    });
    await synchronize(member, owner, stockTables);
    expect(
      (await rows(owner.database, 'Ingredient')).find(({ id }) => id === flour.id)?.quantity,
    ).toBe(1300);

    const list = await owner.local<{ version: number }>(shopping);
    await owner.local(`${shopping}/items`, 'POST', {
      version: list.version,
      ingredientName: '联调土豆',
      quantity: 2,
      unit: 'PIECE',
    });
    const updated = await owner.local<{
      version: number;
      items: { id: string; ingredientName: string }[];
    }>(shopping);
    const potato = updated.items.find((item) => item.ingredientName === '联调土豆')!;
    await owner.local(`${shopping}/check-in`, 'POST', {
      version: updated.version,
      operationId: 'workerd-shopping-checkin',
      itemIds: [potato.id],
    });
    await synchronize(owner, member, [
      ...stockTables,
      'ShoppingList',
      'ShoppingListItem',
      'ShoppingCheckinOperation',
    ]);
    expect(await rows(member.database, 'ShoppingCheckinOperation')).toHaveLength(1);
    owner.engine.start();
  }, 25_000);

  it('downloads validated image variants, broadcasts an atomic restore, and saves old offline work', async () => {
    const { main, thumb, asset } = await owner.addPhoto('sync-photo');
    owner.engine.start();
    await owner.engine.wake();
    await member.engine.pullNow();
    expect(await member.files.readFile({ path: asset.thumbnailPath })).toEqual({ data: thumb });
    expect(await member.files.readFile({ path: asset.storagePath })).toEqual({ data: main });
    const beforeImageRequests = member.requests.filter(({ path }) =>
      path.startsWith('/api/sync/images'),
    ).length;
    await member.engine.pullNow();
    expect(member.requests.filter(({ path }) => path.startsWith('/api/sync/images'))).toHaveLength(
      beforeImageRequests,
    );
    await noOutbox(member.database);

    const banned = await addDevice('removed');
    const binding = await banned.bindMember(await owner.token());
    const bannedToken = await banned.token();
    banned.engine.start();
    await banned.readySocket();
    expect((await revoke(runtime, await owner.token(), binding.binding.memberId)).status).toBe(204);
    await expect
      .poll(() => banned.revocations, pollOptions)
      .toContainEqual({
        memberId: binding.binding.memberId,
        source: 'websocket',
      });
    expect(banned.engine.active).toBe(false);
    const refused = await runtime.dispatchFetch(`${ORIGIN}/api/sync/epoch-reset`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await member.token()}`, 'x-household-epoch': '1' },
      body: JSON.stringify({ uploadId: 'forbidden-reset', page: 0, rows: [], finalize: true }),
    });
    expect(refused.status).toBe(403);

    member.socketFrames.length = 0;
    member.engine.start();
    await member.engine.wake();
    await member.readySocket();
    const { version } = await member.local<{ version: number }>(shopping);
    await member.local(`${shopping}/items`, 'POST', { version, ingredientName: '旧代际离线土豆' });
    const { blob } = await exportBackup(owner.database, { files: owner.files });
    expect((await member.restore(blob)).status).toBe(403);
    expect((await owner.restore(blob)).status).toBe(401);
    const authorize = '/settings/high-risk/authorize';
    const { challenge } = await owner.local<{ challenge: string }>(authorize, 'POST', {
      action: 'RESTORE',
    });
    const { token: grant } = await owner.local<{ token: string }>(authorize, 'POST', {
      action: 'RESTORE',
      challenge,
      confirmation: 'RESTORE_LOCAL_DATA',
    });
    await owner.files.deleteFiles({ paths: [asset.storagePath, asset.thumbnailPath] });
    const restored = await owner.restore(blob, grant);
    expect(restored.status, await restored.clone().text()).toBe(200);
    expect((await owner.engine.status()).epoch).toBe(2);
    expect(await owner.files.readFile({ path: asset.storagePath })).toEqual({ data: main });
    expect(await owner.files.readFile({ path: asset.thumbnailPath })).toEqual({ data: thumb });
    expect((await owner.restore(blob, grant)).status).toBe(401);
    await expect
      .poll(() => member.socketFrames.some((frame) => frame.includes('EPOCH_RESET')), pollOptions)
      .toBe(true);
    await expect.poll(async () => (await member.engine.status()).epoch, pollOptions).toBe(2);
    expect(member.backups).toHaveLength(1);
    const pending = new TextDecoder().decode(unzipSync(member.backups[0]!)['sync/pending.json']);
    expect(pending).toContain('旧代际离线土豆');
    expect(await rows(member.database, 'ShoppingListItem')).toEqual(
      await rows(owner.database, 'ShoppingListItem'),
    );
    await noOutbox(member.database);
    const revoked = await runtime.dispatchFetch(`${ORIGIN}/api/sync/snapshot`, {
      headers: { authorization: `Bearer ${bannedToken}`, 'x-household-epoch': '2' },
    });
    expect(revoked.status).toBe(403);
    expect(await revoked.json()).toMatchObject({
      code: 'MEMBER_REVOKED',
      memberId: binding.binding.memberId,
    });
  }, 25_000);
});
