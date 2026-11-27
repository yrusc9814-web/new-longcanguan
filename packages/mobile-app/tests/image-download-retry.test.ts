import { describe, expect, it } from 'vitest';

import { openDatabase, type DatabaseHandle } from '../src/db/database.js';
import { createNodeSqliteDriver, createTempDatabasePath } from './helpers/node-sqlite-driver.js';
import { createSyncHttpClient, type SyncFetch, type SyncHttpContext } from '../src/sync/http.js';
import { createImageSyncQueue } from '../src/sync/images.js';
import { createSyncEngine } from '../src/sync/engine.js';
import { createMemoryUploadsFiles } from '../src/native/upload-files.js';
import { createMemoryAppSecurity } from '../src/native/app-security.js';
import { sha256Hex } from '../src/modules/uploads/codec.js';

const NOW = new Date('2026-11-22T00:00:00.000Z');
const EPOCH = 3;

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

function client(fetchImpl: SyncFetch) {
  return createSyncHttpClient({ fetch: fetchImpl, context: async () => context() });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Clock {
  value: number;
}

function capturingTimers() {
  const scheduled: { callback: () => void; ms: number }[] = [];
  return {
    scheduled,
    setTimeout(callback: () => void, ms: number) {
      scheduled.push({ callback, ms });
      return scheduled.length;
    },
    clearTimeout() {
      // 测试只关心调度次数与延迟；清理由断言 covered 数决定。
    },
  };
}

async function openMemoryDatabase(): Promise<DatabaseHandle> {
  const handle = await openDatabase({
    driver: createNodeSqliteDriver({ path: ':memory:' }),
    now: () => NOW,
  });
  await handle.setEpoch(EPOCH);
  return handle;
}

async function bindRow(database: DatabaseHandle): Promise<void> {
  await database.withWriteTransaction(async (tx) => {
    await tx.run(
      `UPDATE "device_local_config"
          SET "cloudOrigin" = 'https://cloud.example', "householdId" = 'hh',
              "memberId" = 'm1', "role" = 'MEMBER'
        WHERE "id" = 1`,
    );
  });
}

function uploadAssetRow(input: {
  id: string;
  sha256: string;
  storagePath: string;
  thumbnailPath: string | null;
}) {
  return {
    table: 'UploadAsset',
    id: input.id,
    row: {
      id: input.id,
      filename: `${input.id}.webp`,
      storagePath: input.storagePath,
      thumbnailPath: input.thumbnailPath,
      sha256: input.sha256,
      mimeType: 'image/webp',
      sizeBytes: 4,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    },
  };
}

describe('图片下载退避', () => {
  it('单次 drain 遇 503 只请求一次并保留任务，越过退避后成功下载', async () => {
    const files = createMemoryUploadsFiles();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const sha256 = await sha256Hex(bytes);
    const clock: Clock = { value: NOW.getTime() };
    let requests = 0;
    let failing = true;
    const queue = createImageSyncQueue({
      http: client(async () => {
        requests += 1;
        if (failing) return json(503, { code: 'UNAVAILABLE' });
        return new Response(bytes);
      }),
      files,
      now: () => clock.value,
    });

    queue.enqueueDownload({ sha256, storagePath: 'main.webp', thumbnailPath: null });
    expect(queue.pending).toBe(1);
    expect(queue.due).toBe(1);

    const first = await queue.drain();
    expect(first.failed).toBe(1);
    expect(requests).toBe(1);
    expect(queue.pending).toBe(1);
    expect(queue.due).toBe(0);
    const delay = queue.nextRetryDelay();
    expect(delay).not.toBeNull();
    expect(delay).toBe(1_000);

    // 退避未到期：不重复请求。
    const second = await queue.drain();
    expect(second.failed).toBe(0);
    expect(requests).toBe(1);
    expect(queue.pending).toBe(1);

    failing = false;
    clock.value += 1_000;
    expect(queue.due).toBe(1);
    const third = await queue.drain();
    expect(third).toMatchObject({ downloaded: 1, failed: 0 });
    expect(requests).toBe(2);
    expect(queue.pending).toBe(0);
    expect(queue.nextRetryDelay()).toBeNull();
    expect((await files.statFile({ path: 'main.webp' })).sha256).toBe(sha256);
  });
});

interface HarnessOptions {
  readonly database: DatabaseHandle;
  readonly files: ReturnType<typeof createMemoryUploadsFiles>;
  readonly fetchImpl: SyncFetch;
  readonly clock: Clock;
  readonly timers: ReturnType<typeof capturingTimers>;
}

function createHarness({ database, files, fetchImpl, clock, timers }: HarnessOptions) {
  const security = createMemoryAppSecurity(() => clock.value);
  const engine = createSyncEngine({
    getDatabase: async () => database,
    security,
    fetch: async (url, init) => {
      if (new URL(url).pathname === '/api/sync/ws-ticket') {
        return json(201, { ticket: 'fixture' });
      }
      return fetchImpl(url, init);
    },
    files,
    now: () => new Date(clock.value),
    timers,
    deviceId: () => 'device-test',
    events: () => undefined,
    // 已连接状态的 socket stub，避免 WS 重连定时器混入图片重试断言。
    socketFactory: () => ({
      readyState: 1,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: () => undefined,
      close: () => undefined,
    }),
  });
  return { engine, security };
}

describe('引擎图片登记与重试', () => {
  it('拉取新 UploadAsset 时图片 503 不再紧循环，恢复后下一次同步补齐主图与缩略图', async () => {
    const database = await openMemoryDatabase();
    await bindRow(database);
    const files = createMemoryUploadsFiles();
    const main = new Uint8Array([1, 2, 3, 4]);
    const thumb = new Uint8Array([9, 9]);
    const mainSha = await sha256Hex(main);
    const thumbSha = await sha256Hex(thumb);
    const clock: Clock = { value: NOW.getTime() };
    const timers = capturingTimers();
    let imageGets = 0;
    let failing = true;

    const { engine, security } = createHarness({
      database,
      files,
      clock,
      timers,
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/api/sync/pull') {
          const after = Number(parsed.searchParams.get('after') ?? 0);
          if (after > 0)
            return json(200, { epoch: EPOCH, entries: [], nextSeq: 1, hasMore: false });
          return json(200, {
            epoch: EPOCH,
            entries: [
              {
                seq: 1,
                changes: [
                  uploadAssetRow({
                    id: 'asset-1',
                    sha256: mainSha,
                    storagePath: 'main.webp',
                    thumbnailPath: 'thumb.webp',
                  }),
                ],
              },
            ],
            nextSeq: 1,
            hasMore: false,
          });
        }
        if (parsed.pathname.startsWith('/api/sync/images/')) {
          imageGets += 1;
          if (failing) return json(503, { code: 'UNAVAILABLE' });
          const variant = parsed.searchParams.get('variant');
          if (variant === 'thumb') {
            return new Response(thumb, { headers: { 'x-content-sha256': thumbSha } });
          }
          return new Response(main);
        }
        return json(404, { code: 'NOT_FOUND' });
      },
    });
    await security.setMemberToken({ memberToken: 'tok' });

    try {
      await engine.syncOnce();
      // 主图 + 缩略图各一次，无零延迟紧循环。
      expect(imageGets).toBe(2);
      expect(engine.images.pending).toBe(2);
      expect(engine.images.nextRetryDelay()).not.toBeNull();
      expect(await files.listFiles({})).toEqual({ paths: [] });
      expect(await engine.status()).toMatchObject({ phase: 'ok' });

      failing = false;
      clock.value += 2_000;
      await engine.syncOnce();

      expect(await files.statFile({ path: 'main.webp' })).toMatchObject({
        exists: true,
        sha256: mainSha,
      });
      expect(await files.statFile({ path: 'thumb.webp' })).toMatchObject({
        exists: true,
        sha256: thumbSha,
      });
      expect(engine.images.pending).toBe(0);
      expect(imageGets).toBe(4);
    } finally {
      engine.stop();
      await database.close();
    }
  });

  it('延迟任务只安排一个重试定时器，回调触发后按退避重试', async () => {
    const database = await openMemoryDatabase();
    await bindRow(database);
    const files = createMemoryUploadsFiles();
    const bytes = new Uint8Array([5, 6, 7]);
    const sha256 = await sha256Hex(bytes);
    const clock: Clock = { value: NOW.getTime() };
    const timers = capturingTimers();
    let failing = true;
    let gets = 0;

    const { engine, security } = createHarness({
      database,
      files,
      clock,
      timers,
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/api/sync/pull') {
          return json(200, { epoch: EPOCH, entries: [], nextSeq: 0, hasMore: false });
        }
        if (parsed.pathname.startsWith('/api/sync/images/')) {
          gets += 1;
          if (failing) return json(503, { code: 'UNAVAILABLE' });
          return new Response(bytes);
        }
        return json(404, { code: 'NOT_FOUND' });
      },
    });
    await security.setMemberToken({ memberToken: 'tok' });
    await database.withWriteTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO "UploadAsset" ("id","filename","storagePath","thumbnailPath","mimeType","sizeBytes","sha256","updatedAt")
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          'asset-2',
          'asset-2.webp',
          'main-2.webp',
          null,
          'image/webp',
          3,
          sha256,
          NOW.toISOString(),
        ],
      );
    });

    try {
      engine.start();
      await engine.wake();
      expect(gets).toBe(1);
      expect(timers.scheduled.map((entry) => entry.ms)).toEqual([1_000]);

      // 未到期前再次同步不能重复请求，也不能叠加定时器。
      await engine.syncOnce();
      expect(gets).toBe(1);
      expect(timers.scheduled).toHaveLength(1);

      failing = false;
      clock.value += 1_000;
      timers.scheduled[0]?.callback();
      await expect
        .poll(async () => (await files.statFile({ path: 'main-2.webp' })).exists, { timeout: 5000 })
        .toBe(true);
      expect(gets).toBe(2);
      expect(engine.images.pending).toBe(0);
    } finally {
      engine.stop();
      await database.close();
    }
  });

  it('跨重启用同一数据库文件扫描账本补齐丢失的图片队列', async () => {
    const temp = createTempDatabasePath('image-retry');
    const files = createMemoryUploadsFiles();
    const main = new Uint8Array([3, 1, 4, 1, 5]);
    const thumb = new Uint8Array([2, 7]);
    const mainSha = await sha256Hex(main);
    const thumbSha = await sha256Hex(thumb);
    const clock: Clock = { value: NOW.getTime() };
    const timers = capturingTimers();
    const security = createMemoryAppSecurity(() => clock.value);
    await security.setMemberToken({ memberToken: 'tok' });

    const open = async () => {
      const handle = await openDatabase({
        driver: createNodeSqliteDriver({ path: temp.path }),
        now: () => NOW,
      });
      await handle.setEpoch(EPOCH);
      return handle;
    };

    let firstDatabase: DatabaseHandle | null = await open();
    let secondDatabase: DatabaseHandle | null = null;
    let secondEngine: ReturnType<typeof createSyncEngine> | null = null;
    try {
      await bindRow(firstDatabase);
      const failing = true;
      let imageGets = 0;
      const fetchImpl: SyncFetch = async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/api/sync/pull') {
          const after = Number(parsed.searchParams.get('after') ?? 0);
          if (after > 0)
            return json(200, { epoch: EPOCH, entries: [], nextSeq: 1, hasMore: false });
          return json(200, {
            epoch: EPOCH,
            entries: [
              {
                seq: 1,
                changes: [
                  uploadAssetRow({
                    id: 'asset-3',
                    sha256: mainSha,
                    storagePath: 'main-3.webp',
                    thumbnailPath: 'thumb-3.webp',
                  }),
                ],
              },
            ],
            nextSeq: 1,
            hasMore: false,
          });
        }
        if (parsed.pathname.startsWith('/api/sync/images/')) {
          imageGets += 1;
          if (failing) return json(503, { code: 'UNAVAILABLE' });
          const variant = parsed.searchParams.get('variant');
          if (variant === 'thumb') {
            return new Response(thumb, { headers: { 'x-content-sha256': thumbSha } });
          }
          return new Response(main);
        }
        return json(404, { code: 'NOT_FOUND' });
      };

      const engine = createSyncEngine({
        getDatabase: async () => firstDatabase!,
        security,
        fetch: fetchImpl,
        files,
        now: () => new Date(clock.value),
        timers,
        deviceId: () => 'device-test',
        events: () => undefined,
      });
      await engine.syncOnce();
      expect(imageGets).toBe(2);
      expect(engine.images.pending).toBe(2);
      expect(await files.listFiles({})).toEqual({ paths: [] });
      engine.stop();
      await firstDatabase.close();
      firstDatabase = null;

      // 模拟重启：同一数据库文件、同一批本地文件，内存队列丢失。
      secondDatabase = await open();
      secondEngine = createSyncEngine({
        getDatabase: async () => secondDatabase!,
        security,
        fetch: async (url) => {
          const parsed = new URL(url);
          if (parsed.pathname === '/api/sync/pull') {
            return json(200, { epoch: EPOCH, entries: [], nextSeq: 1, hasMore: false });
          }
          if (parsed.pathname.startsWith('/api/sync/images/')) {
            const variant = parsed.searchParams.get('variant');
            if (variant === 'thumb') {
              return new Response(thumb, { headers: { 'x-content-sha256': thumbSha } });
            }
            return new Response(main);
          }
          return json(404, { code: 'NOT_FOUND' });
        },
        files,
        now: () => new Date(clock.value),
        timers,
        deviceId: () => 'device-test',
        events: () => undefined,
      });
      await secondEngine.syncOnce();

      expect(await files.statFile({ path: 'main-3.webp' })).toMatchObject({
        exists: true,
        sha256: mainSha,
      });
      expect(await files.statFile({ path: 'thumb-3.webp' })).toMatchObject({
        exists: true,
        sha256: thumbSha,
      });
      expect(secondEngine.images.pending).toBe(0);
    } finally {
      secondEngine?.stop();
      await firstDatabase?.close();
      await secondDatabase?.close();
      temp.cleanup();
    }
  });
});
