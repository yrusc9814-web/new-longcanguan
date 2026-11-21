import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type DatabaseHandle } from '../src/db/database.js';
import { SYNC_OUTBOX_TABLE } from '../src/db/schema.js';
import { createLocalApiRouter, type LocalApiRouter } from '../src/local-api/index.js';
import { registerStores } from '../src/modules/stores/index.js';
import { createNodeSqliteDriver } from './helpers/node-sqlite-driver.js';

const ORIGIN = 'http://localhost';
const NOW = new Date('2026-11-21T08:00:00.000Z');

interface Harness {
  readonly db: DatabaseHandle;
  readonly router: LocalApiRouter;
}

interface JsonResult<T = Record<string, unknown>> {
  readonly status: number;
  readonly body: {
    success: boolean;
    data: T | null;
    error: { code: string; message: string; details?: Record<string, unknown> } | null;
  };
}

async function createHarness(): Promise<Harness> {
  const db = await openDatabase({
    driver: createNodeSqliteDriver({ path: ':memory:' }),
    now: () => NOW,
  });
  const router = createLocalApiRouter({
    readGateState: () => ({ pendingWipe: false, pinRequired: false }),
    now: () => NOW,
  });
  registerStores(router, async () => db);
  return { db, router };
}

async function call<T = Record<string, unknown>>(
  router: LocalApiRouter,
  method: string,
  path: string,
  body?: unknown,
): Promise<JsonResult<T>> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const response = await router.handle(new Request(`${ORIGIN}${path}`, init));
  return { status: response.status, body: await response.json() };
}

interface OutboxRow {
  readonly entity: string;
  readonly entityId: string;
  readonly kind: string;
  readonly baseVersion: number | null;
  readonly payloadJson: string | null;
}

async function outbox(db: DatabaseHandle): Promise<OutboxRow[]> {
  return db.query<OutboxRow>(
    `SELECT "entity","entityId","kind","baseVersion","payloadJson" FROM "${SYNC_OUTBOX_TABLE}" ORDER BY rowid`,
  );
}

interface StoreItem {
  id: string;
  name: string;
  version: number;
  favorite: boolean;
  supportsDineIn: boolean;
  supportsTakeout: boolean;
  mealTypes: string[];
  menuItems: Array<{ name: string; price: number | null; isSignature: boolean; sortOrder: number }>;
}

describe('店铺域本地 API', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness();
  });

  it('POST 创建聚合店铺：201、布尔默认值、关联排序与 upsert 发件箱', async () => {
    const { db, router } = harness;
    const created = await call<StoreItem>(router, 'POST', '/api/v1/stores', {
      name: '  小馆  ',
      averageCost: 35.5,
      supportsDineIn: true,
      mealTypes: ['DINNER', 'LUNCH', 'DINNER'],
      menuItems: [
        { name: '牛肉面', price: 28, isSignature: true },
        { name: '酸梅汤', price: 6, sortOrder: 5 },
      ],
    });
    expect(created.status).toBe(201);
    const store = created.body.data as StoreItem;
    expect(store).toMatchObject({
      name: '小馆',
      averageCost: 35.5,
      supportsDineIn: true,
      supportsTakeout: false,
      favorite: false,
      version: 1,
      // 上游 mealTypes 按枚举升序返回
      mealTypes: ['DINNER', 'LUNCH'],
      menuItems: [
        { name: '牛肉面', price: 28, isSignature: true, sortOrder: 0 },
        { name: '酸梅汤', price: 6, isSignature: false, sortOrder: 5 },
      ],
    });

    const rows = await outbox(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entity: 'Store',
      entityId: store.id,
      kind: 'upsert',
      baseVersion: null,
    });
    const payload = JSON.parse(rows[0].payloadJson as string) as Record<string, unknown>;
    expect(payload).toMatchObject({
      id: store.id,
      mealTypes: ['DINNER', 'LUNCH'],
      favorite: false,
    });
    expect((payload.menuItems as unknown[]).length).toBe(2);
  });

  it('POST 非法菜单快速失败且不落库', async () => {
    const { db, router } = harness;
    const invalid = await call(router, 'POST', '/api/v1/stores', {
      name: '坏店',
      menuItems: [{ name: '面', price: 0 }],
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error?.code).toBe('VALIDATION_ERROR');
    expect(await db.query('SELECT COUNT(*) AS total FROM "Store"')).toEqual([{ total: 0 }]);
    expect(await outbox(db)).toEqual([]);
  });

  it('GET 列表按搜索/获取方式/餐次/收藏/人均/标签筛选并分页', async () => {
    const { router } = harness;
    const a = await call<StoreItem>(router, 'POST', '/api/v1/stores', {
      name: '意面小馆',
      supportsDineIn: true,
      averageCost: 50,
      rating: 4.5,
      tagsText: '西餐,面',
      mealTypes: ['DINNER'],
    });
    const b = await call<StoreItem>(router, 'POST', '/api/v1/stores', {
      name: '外卖粥铺',
      supportsTakeout: true,
      averageCost: 20,
      rating: 3,
      tagsText: '早茶',
      mealTypes: ['BREAKFAST'],
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const filtered = await call<{ items: StoreItem[]; total: number; totalPages: number }>(
      router,
      'GET',
      '/api/v1/stores?search=%E6%84%8F%E9%9D%A2&mode=DINE_IN&mealTypes=DINNER&page=1&pageSize=1',
    );
    expect(filtered.body.data).toMatchObject({ total: 1, items: [{ name: '意面小馆' }] });

    const takeout = await call<{ items: StoreItem[]; total: number }>(
      router,
      'GET',
      '/api/v1/stores?mode=TAKEOUT&favorite=false&minAverageCost=10&maxAverageCost=30&tags=%E6%97%A9%E8%8C%B6',
    );
    expect(takeout.body.data).toMatchObject({ total: 1, items: [{ name: '外卖粥铺' }] });

    // 上游 normalizePagination：小数 floor、pageSize 上限夹取到 100
    const paged = await call<{ items: StoreItem[]; page: number; pageSize: number }>(
      router,
      'GET',
      '/api/v1/stores?page=1.9&pageSize=500',
    );
    expect(paged.body.data).toMatchObject({ page: 1, pageSize: 100 });
    expect(paged.body.data?.items).toHaveLength(2);

    const invalid = await call(router, 'GET', '/api/v1/stores?mode=PICNIC');
    expect(invalid.status).toBe(400);
    const invalidSort = await call(router, 'GET', '/api/v1/stores?sortBy=price');
    expect(invalidSort.status).toBe(400);
  });

  it('GET /:id 返回聚合菜单、最近食用与关联记录；软删后 404', async () => {
    const { db, router } = harness;
    const created = await call<StoreItem>(router, 'POST', '/api/v1/stores', {
      name: '面馆',
      mealTypes: ['LUNCH'],
      menuItems: [{ name: '拉面' }],
    });
    const store = created.body.data as StoreItem;
    await db.withWriteTransaction(async (tx) => {
      const stamp = NOW.toISOString();
      await tx.run(
        `INSERT INTO "MealRecord" ("id","recordDate","recordTime","mealType","sourceType","version","createdAt","updatedAt")
         VALUES ('rec-1','2026-11-20','12:30','LUNCH','STORE',1,?,?)`,
        [stamp, stamp],
      );
      await tx.run(
        `INSERT INTO "MealRecordItem" ("id","mealRecordId","itemType","storeId","sortOrder","createdAt","updatedAt")
         VALUES ('item-1','rec-1','STORE',?,0,?,?)`,
        [store.id, stamp, stamp],
      );
    });

    const detail = await call<{
      mealTypes: string[];
      menuItems: Array<{ name: string }>;
      lastEatenDate: string | null;
      historyCount: number;
      relatedRecords: Array<{ id: string; recordDate: string; mealType: string }>;
    }>(router, 'GET', `/api/v1/stores/${store.id}`);
    expect(detail.body.data).toMatchObject({
      mealTypes: ['LUNCH'],
      menuItems: [{ name: '拉面' }],
      lastEatenDate: '2026-11-20',
      historyCount: 1,
      relatedRecords: [{ id: 'rec-1', recordDate: '2026-11-20', mealType: 'LUNCH' }],
    });

    const stale = await call(router, 'GET', '/api/v1/stores/missing');
    expect(stale.status).toBe(404);

    const removed = await call(router, 'DELETE', `/api/v1/stores/${store.id}`, { version: 1 });
    expect(removed.status).toBe(200);
    const gone = await call(router, 'GET', `/api/v1/stores/${store.id}`);
    expect(gone.status).toBe(404);
  });

  it('PUT 局部更新：省略保持、[] 清空、整组替换与版本推进；冲突 409', async () => {
    const { db, router } = harness;
    const created = await call<StoreItem>(router, 'POST', '/api/v1/stores', {
      name: '老店',
      notes: '保留',
      mealTypes: ['LUNCH'],
      menuItems: [{ name: '旧菜' }],
    });
    const store = created.body.data as StoreItem;

    const kept = await call<StoreItem>(router, 'PUT', `/api/v1/stores/${store.id}`, {
      version: 1,
      name: '新店',
    });
    expect(kept.body.data).toMatchObject({
      name: '新店',
      notes: '保留',
      version: 2,
      mealTypes: ['LUNCH'],
      menuItems: [{ name: '旧菜' }],
    });

    const replaced = await call<StoreItem>(router, 'PUT', `/api/v1/stores/${store.id}`, {
      version: 2,
      mealTypes: ['DINNER'],
      menuItems: [{ name: '新菜' }],
    });
    expect(replaced.body.data).toMatchObject({
      version: 3,
      mealTypes: ['DINNER'],
      menuItems: [{ name: '新菜' }],
    });

    const cleared = await call<StoreItem>(router, 'PUT', `/api/v1/stores/${store.id}`, {
      version: 3,
      mealTypes: [],
      menuItems: [],
    });
    expect(cleared.body.data).toMatchObject({ version: 4, mealTypes: [], menuItems: [] });

    const conflict = await call(router, 'PUT', `/api/v1/stores/${store.id}`, {
      version: 1,
      name: '过期写',
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error?.code).toBe('VERSION_CONFLICT');
    expect(await db.query('SELECT "name" FROM "Store" WHERE "id" = ?', [store.id])).toEqual([
      { name: '新店' },
    ]);

    // 严格 rowid FIFO：新建与三次连续更新各留一条，最后一条携带最新 baseVersion 与完整聚合。
    const upserts = (await outbox(db)).filter((row) => row.kind === 'upsert');
    expect(upserts.map((row) => row.baseVersion)).toEqual([null, 1, 2, 3]);
    expect(upserts[0]).toMatchObject({ entityId: store.id });
    const payload = JSON.parse(upserts.at(-1)!.payloadJson as string) as Record<string, unknown>;
    expect(payload).toMatchObject({ name: '新店', mealTypes: [], menuItems: [] });
  });

  it('POST /:id/favorite 走同一乐观锁并写聚合 upsert', async () => {
    const { db, router } = harness;
    const created = await call<StoreItem>(router, 'POST', '/api/v1/stores', { name: '店' });
    const store = created.body.data as StoreItem;

    const favored = await call<StoreItem>(router, 'POST', `/api/v1/stores/${store.id}/favorite`, {
      favorite: true,
      version: store.version,
    });
    expect(favored.body.data).toMatchObject({ favorite: true, version: 2 });
    expect(await db.query('SELECT "favorite" FROM "Store" WHERE "id" = ?', [store.id])).toEqual([
      { favorite: 1 },
    ]);

    const invalid = await call(router, 'POST', `/api/v1/stores/${store.id}/favorite`, {
      favorite: 'yes',
      version: 2,
    });
    expect(invalid.status).toBe(400);
  });

  it('DELETE 优先读取 JSON Body version，兼容 query 并保留离线创建和删除', async () => {
    const { db, router } = harness;
    const viaBody = await call<StoreItem>(router, 'POST', '/api/v1/stores', { name: '甲' });
    const viaQuery = await call<StoreItem>(router, 'POST', '/api/v1/stores', { name: '乙' });
    const bodyStore = viaBody.body.data as StoreItem;
    const queryStore = viaQuery.body.data as StoreItem;

    const bodyDelete = await call(router, 'DELETE', `/api/v1/stores/${bodyStore.id}`, {
      version: bodyStore.version,
    });
    expect(bodyDelete.status).toBe(200);
    expect(bodyDelete.body.data).toMatchObject({ id: bodyStore.id, version: 2 });

    const queryDelete = await call(
      router,
      'DELETE',
      `/api/v1/stores/${queryStore.id}?version=${queryStore.version}`,
    );
    expect(queryDelete.status).toBe(200);

    const missingVersion = await call(router, 'DELETE', `/api/v1/stores/${bodyStore.id}`);
    expect(missingVersion.status).toBe(400);

    const rows = await outbox(db);
    expect(rows.filter((row) => row.kind === 'delete')).toEqual([
      expect.objectContaining({ entityId: bodyStore.id, baseVersion: bodyStore.version }),
      expect.objectContaining({ entityId: queryStore.id, baseVersion: queryStore.version }),
    ]);
    const deleted = await db.query<{ deletedAt: string | null }>(
      'SELECT "deletedAt" FROM "Store" WHERE "id" = ?',
      [bodyStore.id],
    );
    expect(deleted[0]?.deletedAt).toBe(NOW.toISOString());
  });

  it('写事务回滚：菜单插入失败时主表、关联与发件箱全部复原', async () => {
    const { db, router } = harness;
    const created = await call<StoreItem>(router, 'POST', '/api/v1/stores', {
      name: '原店',
      mealTypes: ['DINNER'],
      menuItems: [{ name: '原菜' }],
    });
    const store = created.body.data as StoreItem;
    const tables = ['Store', 'StoreMealType', 'StoreMenuItem', SYNC_OUTBOX_TABLE];
    const snapshot = async () =>
      Promise.all(tables.map((table) => db.query(`SELECT * FROM "${table}" ORDER BY rowid`)));
    const before = await snapshot();

    await db.withWriteTransaction((tx) =>
      tx.exec(
        `CREATE TRIGGER "test_store_failure" BEFORE INSERT ON "StoreMenuItem"
         BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
      ),
    );
    const failed = await call(router, 'PUT', `/api/v1/stores/${store.id}`, {
      name: '新店',
      version: store.version,
      mealTypes: ['LUNCH'],
      menuItems: [{ name: '新菜' }],
    });
    expect(failed.status).toBe(500);
    expect(await snapshot()).toEqual(before);
    expect(await db.query('PRAGMA foreign_key_check')).toEqual([]);
  });
});
