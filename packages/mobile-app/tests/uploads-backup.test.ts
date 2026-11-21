/**
 * uploads + backup 域（T-004 第 6 条）端到端测试。
 *
 * 覆盖：
 * - 真实 WebP 编码落盘、UploadAsset + 发件箱同事务登记、补偿删除；
 * - assertUploadedPhotos 校验（已登记/未登记/伪造路径）；
 * - 导出 ZIP 的 manifest 哈希、27 张脱敏业务表、上传文件字节、私密表字节剔除；
 * - 恢复的隔离校验（哈希/结构/外键）与单事务回滚、outbox 清空、本地配置保留、令牌一次性。
 */
import { createHash } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { openDatabase, type DatabaseHandle } from '../src/db/database.js';
import { BUSINESS_TABLES, SYNC_OUTBOX_TABLE } from '../src/db/schema.js';
import { createLocalApiRouter, type LocalApiRouter } from '../src/local-api/index.js';
import { registerBackups } from '../src/modules/backup/index.js';
import { BACKUP_SCHEMA_VERSION, type BackupManifest } from '../src/modules/backup/service.js';
import { registerSettings } from '../src/modules/settings/index.js';
import { createSettingsService } from '../src/modules/settings/service.js';
import { registerUploads } from '../src/modules/uploads/index.js';
import { assertUploadedPhotos, type UploadServiceOptions } from '../src/modules/uploads/service.js';
import { createMemoryAppSecurity } from '../src/native/app-security.js';
import { createPinSession } from '../src/native/pin-session.js';
import { createMemoryUploadsFiles, type UploadsFilesBridge } from '../src/native/upload-files.js';
import { createNodeSqliteDriver } from './helpers/node-sqlite-driver.js';

const NOW = new Date('2026-11-21T08:00:00.000Z');
const ORIGIN = 'https://localhost';

/** Node 24 无 createImageBitmap/OffscreenCanvas：注入解码 + 编码桩代替画布路径。 */
const encoderStub: UploadServiceOptions = {
  encode: {
    decoder: async (blob) => ({
      width: blob.size,
      height: Math.max(1, Math.round(blob.size / 2)),
      drawTo: () => undefined,
      close: () => undefined,
    }),
    encode: async (bitmap) => {
      const bytes = new TextEncoder().encode(
        `RIFF-webp-${bitmap.width}x${bitmap.height}-${NOW.getTime()}`,
      );
      return {
        webp: new Blob([bytes], { type: 'image/webp' }),
        thumbnail: new Blob([bytes.subarray(0, 4)], { type: 'image/webp' }),
      };
    },
  },
};

interface Harness {
  readonly db: DatabaseHandle;
  readonly router: LocalApiRouter;
  readonly files: UploadsFilesBridge;
}

let harness: Harness;

function registerRoutes(
  { db, router, files }: Harness,
  session: ReturnType<typeof createPinSession>,
): void {
  const settings = createSettingsService(
    async () => db,
    session,
    () => NOW,
  );
  registerUploads(router, async () => db, {
    uploadServiceOptions: { ...encoderStub, files },
  });
  registerBackups(router, async () => db, {
    consumers: {
      consumeHighRiskToken: settings.consumeHighRiskToken,
      lockPin: async () => {
        await settings.lockPin();
      },
    },
    files,
  });
  registerSettings(router, settings);
}

async function call(
  path: string,
  method = 'GET',
  body?: RequestBody,
  headers: Record<string, string> = {},
): Promise<Response> {
  const init: RequestInit = { method, headers };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json', ...headers };
  } else {
    init.headers = headers;
  }
  return harness.router.handle(new Request(`${ORIGIN}/api/v1${path}`, init));
}

type RequestBody = Record<string, unknown> | FormData;

beforeEach(async () => {
  const db = await openDatabase({
    driver: createNodeSqliteDriver({ path: ':memory:' }),
    now: () => NOW,
  });
  const security = createMemoryAppSecurity(() => NOW.getTime());
  const session = createPinSession(security, () => NOW.getTime());
  const router = createLocalApiRouter({
    readGateState: () =>
      security.getGateState().then((state) => ({
        pendingWipe: state.lockedPendingWipe,
        pinRequired: state.pinRequired,
      })),
    isPinTokenValid: session.isValid,
    now: () => NOW,
  });
  harness = { db, router, files: createMemoryUploadsFiles() };
  registerRoutes(harness, session);
});
afterEach(async () => {
  await harness.db.close();
});

describe('POST /uploads/images：真实落盘与登记', () => {
  it('上传后文件落盘、UploadAsset 入库并发件箱同事务登记', async () => {
    const form = new FormData();
    form.append('file', new Blob(['fake-jpeg'], { type: 'image/jpeg' }), 'photo.jpg');
    const response = await call('/uploads/images', 'POST', form);
    expect(response.status).toBe(201);
    const asset = (await response.json()) as { data: Record<string, unknown> };

    expect(String(asset.data.url)).toMatch(/^\/uploads\/main-[a-z0-9-]+\.webp$/);
    expect(String(asset.data.thumbnailUrl)).toMatch(/^\/uploads\/thumb-[a-z0-9-]+\.webp$/);
    expect(asset.data.mimeType).toBe('image/webp');

    const filename = String(asset.data.url).slice('/uploads/'.length);
    const stored = await harness.files.readFile({ path: filename });
    expect(stored.data).not.toBeNull();
    const expectedSha = createHash('sha256')
      .update(stored.data as Uint8Array)
      .digest('hex');
    expect(asset.data.sizeBytes).toBe((stored.data as Uint8Array).byteLength);
    const [row] = await harness.db.query<{ sha256: string; sizeBytes: number; deletedAt: null }>(
      'SELECT "sha256","sizeBytes","deletedAt" FROM "UploadAsset" WHERE "filename" = ?',
      [filename],
    );
    expect(row.sha256).toBe(expectedSha);
    expect(row.sizeBytes).toBe(asset.data.sizeBytes);
    expect(row.deletedAt).toBeNull();

    const [outbox] = await harness.db.query<{ payloadJson: string }>(
      `SELECT "payloadJson" FROM "${SYNC_OUTBOX_TABLE}" WHERE "entity" = 'UploadAsset'`,
    );
    expect(JSON.parse(outbox.payloadJson)).toMatchObject({
      id: asset.data.id,
      filename,
      sha256: expectedSha,
    });
  });

  it('非 multipart 或缺少 file 字段按 400/422 快速失败且不落盘', async () => {
    const bad = await call('/uploads/images', 'POST', { file: 'nope' });
    expect(bad.status).toBe(400);
    const empty = new FormData();
    const response = await call('/uploads/images', 'POST', empty);
    expect(response.status).toBe(422);
    const listed = await harness.files.listFiles({});
    expect(listed.paths).toEqual([]);
  });
});

describe('assertUploadedPhotos', () => {
  it('已登记路径通过、伪造路径被点名', async () => {
    const form = new FormData();
    form.append('file', new Blob(['x'], { type: 'image/jpeg' }), 'a.jpg');
    const asset = (
      (await (await call('/uploads/images', 'POST', form)).json()) as { data: { url: string } }
    ).data;

    expect(await assertUploadedPhotos(harness.db, [asset.url])).toEqual([]);
    const missing = await assertUploadedPhotos(harness.db, [asset.url, '/uploads/fake-1.webp']);
    expect(missing).toEqual(['fake-1.webp']);
  });
});

describe('GET /backups/export：脱敏 ZIP', () => {
  it('包含 27 张业务表 + 引用图片；manifest 哈希逐条成立；零私密字节', async () => {
    const form = new FormData();
    form.append('file', new Blob(['image-bytes'], { type: 'image/jpeg' }), 'b.jpg');
    const asset = (
      (await (await call('/uploads/images', 'POST', form)).json()) as {
        data: { id: string; url: string; thumbnailUrl: string };
      }
    ).data;
    await call('/settings', 'PUT', { version: 1, userNickname: '私密昵称' });

    const response = await call('/backups/export');
    expect(response.status).toBe(200);
    const zip = new Uint8Array(await response.arrayBuffer());
    const archive = unzipSync(zip);
    const manifest = JSON.parse(
      strFromU8(archive['manifest.json'] as Uint8Array),
    ) as BackupManifest;

    expect(manifest.schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
    expect(manifest.tables).toEqual(BUSINESS_TABLES);
    for (const [name, entry] of Object.entries(manifest.files)) {
      const bytes = archive[name];
      expect(bytes, name).toBeDefined();
      expect(bytes.byteLength).toBe(entry.size);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
    }
    expect(archive[asset.url.slice(1)]).toBeDefined();
    expect(archive[asset.thumbnailUrl.slice(1)]).toBeDefined();

    const raw = strFromU8(zip.subarray(0, zip.length), true);
    expect(raw).not.toContain('device_local_config');
    expect(raw).not.toContain('sync_outbox');
    expect(raw).not.toContain('sync_state');
    const nickname = strFromU8(archive['db/Settings.json'] as Uint8Array);
    expect(nickname).not.toContain('私密昵称');
    expect(strFromU8(archive['db/UploadAsset.json'] as Uint8Array)).toContain(asset.id);
  });

  it('引用文件被删除后导出返回 409 阻止残缺备份', async () => {
    const form = new FormData();
    form.append('file', new Blob(['gone'], { type: 'image/jpeg' }), 'c.jpg');
    const asset = (
      (await (await call('/uploads/images', 'POST', form)).json()) as { data: { url: string } }
    ).data;
    await harness.files.deleteFiles({ paths: [asset.url.slice('/uploads/'.length)] });
    const response = await call('/backups/export');
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UPLOAD_FILE_MISSING');
  });
});

describe('POST /backups/restore：隔离校验与原子恢复', () => {
  async function exportZip(): Promise<Uint8Array> {
    expect((await call('/settings')).status).toBe(200);
    const response = await call('/backups/export');
    expect(response.status).toBe(200);
    return new Uint8Array(await response.arrayBuffer());
  }

  function restoreForm(zip: Uint8Array): FormData {
    const form = new FormData();
    form.append(
      'file',
      new Blob([zip as unknown as BlobPart], { type: 'application/zip' }),
      'backup.zip',
    );
    return form;
  }

  async function authorize(): Promise<string> {
    const response = await call('/settings/high-risk/authorize', 'POST', { action: 'RESTORE' });
    const body = (await response.json()) as {
      data: { token?: string; challenge?: string } | null;
    };
    if (body.data?.token) return body.data.token;
    const challenge = body.data?.challenge;
    if (!challenge) throw new Error(`authorize failed: ${response.status}`);
    const confirmed = await call('/settings/high-risk/authorize', 'POST', {
      action: 'RESTORE',
      challenge,
      confirmation: 'RESTORE_LOCAL_DATA',
    });
    const done = (await confirmed.json()) as { data: { token: string } | null };
    if (!done.data?.token) throw new Error(`authorize confirm failed: ${confirmed.status}`);
    return done.data.token;
  }

  it('令牌缺失 → 401；篡改表数据 → 422；全部校验通过后原子恢复并清空 outbox', async () => {
    const zip = await exportZip();

    const noToken = await call('/backups/restore', 'POST', restoreForm(zip));
    expect(noToken.status).toBe(401);

    // 改为同字节长度的名称，让 ZIP 通过大小检查并命中哈希校验。
    const archive = unzipSync(zip);
    const key = 'db/Settings.json';
    const settings = strFromU8(archive[key]!);
    const tampered = new TextEncoder().encode(settings.replace('搭饭小馆', '测试小馆'));
    expect(tampered).not.toEqual(archive[key]);
    archive[key] = tampered;
    const { zipSync } = await import('fflate');
    const badZip = zipSync(archive as never);
    const tamperedResponse = await call('/backups/restore', 'POST', restoreForm(badZip), {
      'X-High-Risk-Token': await authorize(),
    });
    expect(tamperedResponse.status).toBe(422);

    expect((await call('/settings', 'PUT', { version: 1, subtitle: '恢复前修改' })).status).toBe(
      200,
    );
    const restoreToken = await authorize();
    const good = await call('/backups/restore', 'POST', restoreForm(zip), {
      'X-High-Risk-Token': restoreToken,
    });
    expect(good.status).toBe(200);
    expect(((await good.json()) as { data: { restoredTables: number } }).data.restoredTables).toBe(
      27,
    );
    const [outboxCount] = await harness.db.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM "${SYNC_OUTBOX_TABLE}"`,
    );
    expect(outboxCount.count).toBe(0);
    const replay = await call('/backups/restore', 'POST', restoreForm(zip), {
      'X-High-Risk-Token': restoreToken,
    });
    expect(replay.status).toBe(401);
  });

  it('恢复后数据回到导出时快照（回滚语义），本地配置保留', async () => {
    const zip = await exportZip();
    await call('/settings', 'PUT', { version: 1, appName: '恢复后不应保留的新名' });
    const before = await harness.db.query<{ appName: string }>('SELECT "appName" FROM "Settings"');
    expect(before[0].appName).toBe('恢复后不应保留的新名');

    const response = await call('/backups/restore', 'POST', restoreForm(zip), {
      'X-High-Risk-Token': await authorize(),
    });
    expect(response.status).toBe(200);
    const after = await harness.db.query<{ appName: string }>('SELECT "appName" FROM "Settings"');
    expect(after[0].appName).toBe('搭饭小馆');
  });

  it('目录激活后发生异常时恢复旧文件、业务行与发件箱', async () => {
    const zip = await exportZip();
    expect((await call('/settings', 'PUT', { version: 1, subtitle: '保留现有数据' })).status).toBe(
      200,
    );
    const bytes = new TextEncoder().encode('existing-image');
    await harness.files.writeFile({ path: 'existing.webp', data: bytes });
    const activate = harness.files.activateRestore;
    harness.files.activateRestore = async (options) => {
      await activate(options);
      throw new Error('injected directory swap failure');
    };
    const response = await call('/backups/restore', 'POST', restoreForm(zip), {
      'X-High-Risk-Token': await authorize(),
    });
    expect(response.status).toBe(500);
    expect(await harness.files.readFile({ path: 'existing.webp' })).toEqual({ data: bytes });
    expect(await harness.db.query('SELECT "subtitle" FROM "Settings"')).toEqual([
      { subtitle: '保留现有数据' },
    ]);
    expect(await harness.db.query('SELECT COUNT(*) AS count FROM "sync_outbox"')).toEqual([
      { count: 1 },
    ]);
    expect(await harness.db.query('PRAGMA application_id')).toEqual([{ application_id: 0 }]);
  });

  it('外键悬挂 → 422 且事务回滚（表数据不被半替换）', async () => {
    const zip = await exportZip();
    const archive = unzipSync(zip);
    // 重算 manifest 与哈希，构造"结构合法但 FK 悬挂"的 InventoryBatch。
    const batches = JSON.parse(
      strFromU8(archive['db/InventoryBatch.json'] as Uint8Array),
    ) as unknown[];
    batches.push({
      id: 'orphan-batch',
      ingredientId: 'no-such-ingredient',
      quantity: 1,
      unit: 'GRAM',
      opened: false,
      consumePriority: false,
      version: 1,
      deletedAt: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      purchaseDate: null,
      expiryDate: null,
      location: null,
      notes: null,
    });
    const { zipSync } = await import('fflate');
    const files: Record<string, Uint8Array> = { ...archive };
    const manifest = JSON.parse(strFromU8(files['manifest.json'] as Uint8Array)) as BackupManifest;
    const recalculated: Record<string, { size: number; sha256: string }> = {};
    for (const name of Object.keys(files)) {
      if (name === 'manifest.json') continue;
      const bytes =
        name === 'db/InventoryBatch.json'
          ? new TextEncoder().encode(JSON.stringify(batches))
          : (files[name] as Uint8Array);
      files[name] = bytes;
      recalculated[name] = {
        size: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    }
    const badManifest = { ...manifest, files: recalculated };
    files['manifest.json'] = new TextEncoder().encode(JSON.stringify(badManifest));
    const badZip = zipSync(files as never);
    const response = await call('/backups/restore', 'POST', restoreForm(badZip), {
      'X-High-Risk-Token': await authorize(),
    });
    expect(response.status).toBe(422);
    const [row] = await harness.db.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM "InventoryBatch"',
    );
    expect(row.count).toBe(0); // 原库本表为空且未被污染
  });
});
