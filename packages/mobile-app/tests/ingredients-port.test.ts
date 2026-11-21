import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type DatabaseHandle } from '../src/db/database.js';
import { SYNC_OUTBOX_TABLE } from '../src/db/schema.js';
import {
  createLocalApiFetch,
  createLocalApiRouter,
  type LocalApiRouter,
} from '../src/local-api/index.js';
import { localDate } from '../src/modules/common.js';
import { registerIngredients } from '../src/modules/ingredients/index.js';
import { ADAPTER_PIN_KEY, loadGoogle2Adapter } from './local-api-adapter-harness.js';
import { createNodeSqliteDriver } from './helpers/node-sqlite-driver.js';

const ORIGIN = 'http://localhost';
const TOKEN = '{{SECRET_t003pin}}';
const NOW = new Date('2026-11-21T08:00:00.000Z');
const TODAY = localDate(NOW);

interface Harness {
  readonly db: DatabaseHandle;
  readonly router: LocalApiRouter;
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
  registerIngredients(router, async () => db);
  return { db, router };
}

interface JsonResult<T = Record<string, unknown>> {
  readonly status: number;
  readonly body: {
    success: boolean;
    data: T | null;
    error: { code: string; message: string; details?: Record<string, unknown> } | null;
  };
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
  readonly opId: string;
  readonly entity: string;
  readonly entityId: string;
  readonly kind: string;
  readonly commandType: string | null;
  readonly baseVersion: number | null;
  readonly payloadJson: string | null;
  readonly payloadHash: string | null;
}

async function outbox(db: DatabaseHandle): Promise<OutboxRow[]> {
  return db.query<OutboxRow>(
    `SELECT "opId","entity","entityId","kind","commandType","baseVersion","payloadJson","payloadHash"
     FROM "${SYNC_OUTBOX_TABLE}" ORDER BY rowid`,
  );
}

async function countLogs(db: DatabaseHandle, ingredientId: string): Promise<number> {
  const rows = await db.query<{ total: number }>(
    'SELECT COUNT(*) AS total FROM "InventoryLog" WHERE "ingredientId" = ?',
    [ingredientId],
  );
  return rows[0]?.total ?? 0;
}

async function batchRows(
  db: DatabaseHandle,
  ingredientId: string,
): Promise<
  Array<{
    id: string;
    quantity: number;
    unit: string;
    version: number;
    consumePriority: number;
    opened: number;
    expiryDate: string | null;
  }>
> {
  return db.query(
    'SELECT * FROM "InventoryBatch" WHERE "ingredientId" = ? AND "deletedAt" IS NULL ORDER BY "consumePriority" DESC, "expiryDate" ASC, "createdAt" ASC, "id" ASC',
    [ingredientId],
  );
}

describe('POST /api/v1/ingredients', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness();
  });

  it('创建食材：显式批次换算汇总、PURCHASE 日志、201 与单条 upsert 发件箱', async () => {
    const { db, router } = harness;
    const created = await call(router, 'POST', '/api/v1/ingredients', {
      name: '  高筋面粉 ',
      unit: 'GRAM',
      category: '粮油',
      minStock: 200,
      maxStock: 3000,
      batches: [
        {
          quantity: 1,
          unit: 'KILOGRAM',
          expiryDate: '2026-12-01',
          consumePriority: true,
          opened: false,
        },
        { quantity: 500, unit: 'GRAM', expiryDate: '2026-12-05' },
      ],
    });

    expect(created.status).toBe(201);
    const data = created.body.data as Record<string, unknown>;
    expect(data).toMatchObject({
      name: '高筋面粉',
      unit: 'GRAM',
      quantity: 1500,
      category: '主食粮油',
      minStock: 200,
      maxStock: 3000,
      version: 1,
      deletedAt: null,
      opened: false,
      status: 'NORMAL',
    });
    // 原生布尔：SQLite 的 0/1 不得漏出
    expect(data.opened).toBe(false);
    expect(Array.isArray(data.inventoryBatches)).toBe(true);
    expect(Array.isArray(data.batches)).toBe(true);
    const batches = data.inventoryBatches as Array<Record<string, unknown>>;
    expect(batches).toHaveLength(2);
    expect(batches[0]).toMatchObject({
      quantity: 1,
      unit: 'KILOGRAM',
      consumePriority: true,
      opened: false,
    });

    const ingredientId = data.id as string;
    expect(await countLogs(db, ingredientId)).toBe(2);
    const logs = await db.query<{ changeType: string; changeQuantity: number; unit: string }>(
      'SELECT "changeType","changeQuantity","unit" FROM "InventoryLog" WHERE "ingredientId" = ? ORDER BY "createdAt" ASC, "id" ASC',
      [ingredientId],
    );
    expect(logs.map((log) => log.changeType)).toEqual(['PURCHASE', 'PURCHASE']);
    expect(logs.map((log) => log.changeQuantity).sort((a, b) => a - b)).toEqual([1, 500]);

    const rows = await outbox(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entity: 'Ingredient',
      entityId: ingredientId,
      kind: 'upsert',
      commandType: null,
      baseVersion: null,
    });
    expect(rows[0]!.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    const payload = JSON.parse(rows[0]!.payloadJson as string) as Record<string, unknown>;
    expect(payload).toMatchObject({
      id: ingredientId,
      name: '高筋面粉',
      quantity: 1500,
      version: 1,
    });
    expect((payload.batches as unknown[]).length).toBe(2);
    // 初始 PURCHASE 完整落库事实：id / 库存外键 / 前后数量 / 时间
    const inventoryLogs = payload.inventoryLogs as Array<Record<string, unknown>>;
    expect(inventoryLogs).toHaveLength(2);
    const storedLogs = await db.query<Record<string, unknown>>(
      'SELECT * FROM "InventoryLog" WHERE "ingredientId" = ? ORDER BY rowid',
      [ingredientId],
    );
    for (const [index, log] of storedLogs.entries()) {
      expect(inventoryLogs[index]).toMatchObject({
        id: log.id,
        ingredientId: log.ingredientId,
        inventoryBatchId: log.inventoryBatchId,
        beforeQuantity: 0,
        changeType: 'PURCHASE',
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      });
      expect(inventoryLogs[index]!.changeQuantity).toBe(log.changeQuantity);
      expect(inventoryLogs[index]!.afterQuantity).toBe(log.afterQuantity);
    }
  });

  it('缺少名称 / 单位不可换算 / 负数量 → 400 且不写库、不入队', async () => {
    const { db, router } = harness;
    const cases: Array<Record<string, unknown>> = [
      { unit: 'GRAM' },
      { name: '  ', unit: 'GRAM' },
      { name: '维度错配', unit: 'GRAM', batches: [{ quantity: 1, unit: 'PIECE' }] },
      { name: '负库存', unit: 'GRAM', batches: [{ quantity: -1, unit: 'GRAM' }] },
      { name: '未知单位', unit: 'CUP' },
    ];
    for (const body of cases) {
      const result = await call(router, 'POST', '/api/v1/ingredients', body);
      expect(result.status).toBe(400);
      expect(result.body.error?.code).toBe('VALIDATION_ERROR');
    }
    const [ingredients] = await db.query<{ total: number }>(
      'SELECT COUNT(*) AS total FROM "Ingredient"',
    );
    expect(ingredients?.total).toBe(0);
    expect(await outbox(db)).toHaveLength(0);
  });
});

describe('GET /api/v1/ingredients', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness();
  });

  async function seed(): Promise<void> {
    const { router } = harness;
    await call(router, 'POST', '/api/v1/ingredients', {
      name: '西红柿',
      unit: 'GRAM',
      batches: [{ quantity: 500, unit: 'GRAM', expiryDate: '2026-11-22' }],
    });
    await call(router, 'POST', '/api/v1/ingredients', {
      name: '鸡蛋',
      unit: 'PIECE',
      minStock: 10,
      batches: [{ quantity: 6, unit: 'PIECE' }],
    });
    await call(router, 'POST', '/api/v1/ingredients', {
      name: '空瓶酱油',
      unit: 'MILLILITER',
      category: '调味品',
      batches: [{ quantity: 0, unit: 'MILLILITER' }],
    });
  }

  it('分页信封、分类归一与状态筛选（本地日历）', async () => {
    const { router } = harness;
    await seed();

    const all = await call<{
      items: Array<Record<string, unknown>>;
      total: number;
      page: number;
      pageSize: number;
      totalPages: number;
    }>(router, 'GET', '/api/v1/ingredients?page=1&pageSize=100');
    expect(all.status).toBe(200);
    expect(all.body.data).toMatchObject({ page: 1, pageSize: 100, total: 3, totalPages: 1 });
    const items = all.body.data!.items;
    expect(items.map((item) => item.name).sort()).toEqual(['鸡蛋', '空瓶酱油', '西红柿'].sort());
    const tomato = items.find((item) => item.name === '西红柿')!;
    expect(tomato.category).toBe('蔬菜');
    expect(tomato.opened).toBe(false);

    const seasoning = await call<{ items: Array<Record<string, unknown>>; total: number }>(
      router,
      'GET',
      `/api/v1/ingredients?category=${encodeURIComponent('调味')}`,
    );
    expect(seasoning.body.data!.total).toBe(1);
    expect(seasoning.body.data!.items[0]!.name).toBe('空瓶酱油');

    const expiring = await call<{ items: Array<Record<string, unknown>> }>(
      router,
      'GET',
      '/api/v1/ingredients?status=EXPIRING_SOON',
    );
    expect(expiring.body.data!.items.map((item) => item.name)).toEqual(['西红柿']);

    const depleted = await call<{ items: Array<Record<string, unknown>> }>(
      router,
      'GET',
      '/api/v1/ingredients?status=DEPLETED',
    );
    expect(depleted.body.data!.items.map((item) => item.name)).toEqual(['空瓶酱油']);

    const lowStock = await call<{ items: Array<Record<string, unknown>> }>(
      router,
      'GET',
      '/api/v1/ingredients?status=LOW_STOCK',
    );
    expect(lowStock.body.data!.items.map((item) => item.name)).toEqual(['鸡蛋']);

    const invalid = await call(router, 'GET', '/api/v1/ingredients?status=BOGUS');
    expect(invalid.status).toBe(400);

    // 分页第二页：pageSize=2 → totalPages=2
    const second = await call<{ items: unknown[]; totalPages: number }>(
      router,
      'GET',
      '/api/v1/ingredients?page=2&pageSize=2',
    );
    expect(second.body.data).toMatchObject({ totalPages: 2 });
    expect(second.body.data!.items).toHaveLength(1);
  });

  it('GET /:id 返回详情与状态，不存在 → 404', async () => {
    const { router } = harness;
    await seed();
    const list = await call<{ items: Array<Record<string, unknown>> }>(
      router,
      'GET',
      '/api/v1/ingredients?pageSize=100',
    );
    const tomato = list.body.data!.items.find((item) => item.name === '西红柿')!;
    const detail = await call<Record<string, unknown>>(
      router,
      'GET',
      `/api/v1/ingredients/${tomato.id}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({ name: '西红柿', status: 'EXPIRING_SOON' });
    expect((detail.body.data!.inventoryBatches as unknown[]).length).toBe(1);

    const missing = await call(router, 'GET', '/api/v1/ingredients/not-exist');
    expect(missing.status).toBe(404);
    expect(missing.body.error?.code).toBe('NOT_FOUND');
  });
});

describe('PUT /api/v1/ingredients/:id', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness();
  });

  async function create(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const created = await call(harness.router, 'POST', '/api/v1/ingredients', body);
    expect(created.status).toBe(201);
    return created.body.data as Record<string, unknown>;
  }

  it('数量增加 → 补差额批次 + ADJUST 日志；只入队一条命令', async () => {
    const { db, router } = harness;
    const ingredient = await create({
      name: '编辑加量面粉',
      unit: 'GRAM',
      batches: [{ quantity: 1000, unit: 'GRAM', expiryDate: '2026-12-01' }],
    });

    const updated = await call<Record<string, unknown>>(
      router,
      'PUT',
      `/api/v1/ingredients/${ingredient.id}`,
      {
        version: 1,
        name: '编辑加量面粉',
        unit: 'GRAM',
        quantity: 1300,
        expiryDate: '2027-01-01',
        opened: true,
      },
    );
    expect(updated.status).toBe(200);
    // 上游 PUT 不写 Ingredient.opened，只把 opened 同步进批次；汇总 opened 保持不变。
    expect(updated.body.data).toMatchObject({
      quantity: 1300,
      version: 2,
      opened: false,
      expiryDate: '2027-01-01',
    });

    const batches = await batchRows(db, ingredient.id as string);
    // 同到期日/同 createdAt 时批次顺序按 id 决定，这里只比较数量集合
    expect(batches.map((batch) => batch.quantity).sort((a, b) => a - b)).toEqual([300, 1000]);
    expect(batches.every((batch) => batch.expiryDate === '2027-01-01')).toBe(true);
    expect(batches.every((batch) => batch.opened === 1)).toBe(true);

    const logs = await db.query<{
      changeType: string;
      changeQuantity: number;
      notes: string | null;
    }>(
      'SELECT "changeType","changeQuantity","notes" FROM "InventoryLog" WHERE "ingredientId" = ? ORDER BY "createdAt" ASC, rowid ASC',
      [String(ingredient.id)],
    );
    expect(logs.map((log) => log.changeType)).toEqual(['PURCHASE', 'ADJUST']);
    expect(logs[1]!.changeQuantity).toBe(300);
    expect(logs[1]!.notes).toBe('食材编辑同步库存');

    const rows = await outbox(db);
    // 创建 upsert + 编辑命令，各一条；编辑绝不能额外产生 upsert
    expect(rows.map((row) => row.kind)).toEqual(['upsert', 'command']);
    expect(rows[1]).toMatchObject({
      entity: 'Ingredient',
      entityId: ingredient.id,
      kind: 'command',
      commandType: 'INGREDIENT_UPDATE_SYNC_BATCHES',
      baseVersion: 1,
    });
    const payload = JSON.parse(rows[1]!.payloadJson as string) as Record<string, unknown>;
    expect(payload).toMatchObject({ id: ingredient.id, baseVersion: 1 });
    expect(payload.executedAt).toBe(NOW.toISOString());
    // 数量差额补建：批次与日志 ID 均取自已落库行
    const addedBatch = payload.addedBatch as { batchId: string; logId: string };
    expect(addedBatch.batchId).toBeTruthy();
    expect(addedBatch.logId).toBeTruthy();
    const [addedLog] = await db.query<{ id: string; inventoryBatchId: string }>(
      'SELECT "id","inventoryBatchId" FROM "InventoryLog" WHERE "notes" = ?',
      ['食材编辑同步库存'],
    );
    expect(addedBatch.logId).toBe(addedLog!.id);
    expect(addedBatch.batchId).toBe(addedLog!.inventoryBatchId);
    expect(payload.request).toMatchObject({
      name: '编辑加量面粉',
      unit: 'GRAM',
      quantity: 1300,
      expiryDate: '2027-01-01',
      opened: true,
    });
    expect(payload.request).not.toHaveProperty('purchaseDate');
    expect(payload.request).not.toHaveProperty('metaTouched');
  });

  it('数量减少 → 按 consumePriority/到期日顺序扣减并写 MANUAL_DEDUCT', async () => {
    const { db, router } = harness;
    const ingredient = await create({
      name: '编辑减量牛奶',
      unit: 'MILLILITER',
      batches: [
        { quantity: 200, unit: 'MILLILITER', expiryDate: '2026-12-31' },
        { quantity: 300, unit: 'MILLILITER', expiryDate: '2026-12-01', consumePriority: true },
      ],
    });
    expect(ingredient.quantity).toBe(500);

    const updated = await call<Record<string, unknown>>(
      router,
      'PUT',
      `/api/v1/ingredients/${ingredient.id}`,
      {
        version: 1,
        name: '编辑减量牛奶',
        unit: 'MILLILITER',
        quantity: 250,
      },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({ quantity: 250, version: 2 });

    const batches = await batchRows(db, ingredient.id as string);
    // 优先批次 300 先扣 250 → 剩 50；另一批次 200 不动
    expect(batches.map((batch) => [batch.quantity, batch.expiryDate])).toEqual([
      [50, '2026-12-01'],
      [200, '2026-12-31'],
    ]);
    const logs = await db.query<{
      changeType: string;
      changeQuantity: number;
      inventoryBatchId: string;
    }>(
      'SELECT "changeType","changeQuantity","inventoryBatchId" FROM "InventoryLog" WHERE "ingredientId" = ? ORDER BY rowid ASC',
      [String(ingredient.id)],
    );
    expect(
      logs.filter((log) => log.changeType === 'MANUAL_DEDUCT').map((log) => log.changeQuantity),
    ).toEqual([-250]);
  });

  it('仅改基础单位时按批次换算重算汇总（GRAM → KILOGRAM）', async () => {
    const { router } = harness;
    const ingredient = await create({
      name: '单位换算面粉',
      unit: 'GRAM',
      batches: [
        { quantity: 1000, unit: 'GRAM' },
        { quantity: 500, unit: 'GRAM' },
      ],
    });
    const updated = await call<Record<string, unknown>>(
      router,
      'PUT',
      `/api/v1/ingredients/${ingredient.id}`,
      {
        version: 1,
        name: '单位换算面粉',
        unit: 'KILOGRAM',
      },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({ unit: 'KILOGRAM', quantity: 1.5, version: 2 });
  });

  it('不可换算的基础单位修改 → 409 且完整回滚（名称/版本/发件箱均不变）', async () => {
    const { db, router } = harness;
    const ingredient = await create({
      name: '按个计数鸡蛋',
      unit: 'PIECE',
      batches: [{ quantity: 6, unit: 'PIECE' }],
    });
    const before = await outbox(db);

    const failed = await call(router, 'PUT', `/api/v1/ingredients/${ingredient.id}`, {
      version: 1,
      name: '不应保存的新名称',
      unit: 'GRAM',
    });
    expect(failed.status).toBe(409);
    expect(failed.body.error?.code).toBe('CONFLICT');

    const [row] = await db.query<Record<string, unknown>>(
      'SELECT * FROM "Ingredient" WHERE "id" = ?',
      [String(ingredient.id)],
    );
    expect(row).toMatchObject({ name: '按个计数鸡蛋', unit: 'PIECE', quantity: 6, version: 1 });
    expect((await batchRows(db, ingredient.id as string)).map((batch) => batch.quantity)).toEqual([
      6,
    ]);
    expect(await outbox(db)).toEqual(before);
    expect(await countLogs(db, ingredient.id as string)).toBe(1);
  });

  it('过期版本 409 VERSION_CONFLICT，附带双端版本', async () => {
    const { router } = harness;
    const ingredient = await create({
      name: '版本校验盐',
      unit: 'GRAM',
      batches: [{ quantity: 10, unit: 'GRAM' }],
    });
    const stale = await call(router, 'PUT', `/api/v1/ingredients/${ingredient.id}`, {
      version: 9,
      name: '版本校验盐',
      unit: 'GRAM',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { entity: 'Ingredient', id: ingredient.id, expectedVersion: 9, actualVersion: 1 },
    });
  });

  it('显式 batches 单位不可换算 → 400，不产生任何写入', async () => {
    const { db, router } = harness;
    const ingredient = await create({
      name: '批次校验油',
      unit: 'MILLILITER',
      batches: [{ quantity: 500, unit: 'MILLILITER' }],
    });
    const before = await outbox(db);
    const failed = await call(router, 'PUT', `/api/v1/ingredients/${ingredient.id}`, {
      version: 1,
      name: '批次校验油',
      unit: 'MILLILITER',
      batches: [{ quantity: 1, unit: 'PIECE' }],
    });
    expect(failed.status).toBe(400);
    expect(failed.body.error?.code).toBe('VALIDATION_ERROR');
    expect(await outbox(db)).toEqual(before);
    const [row] = await db.query<Record<string, unknown>>(
      'SELECT "version","quantity" FROM "Ingredient" WHERE "id" = ?',
      [String(ingredient.id)],
    );
    expect(row).toMatchObject({ version: 1, quantity: 500 });
  });

  it('显式 batches：替换活批次（软删退役旧批次），按新批次汇总', async () => {
    const { db, router } = harness;
    const ingredient = await create({
      name: '替换批次面粉',
      unit: 'KILOGRAM',
      batches: [{ quantity: 1, unit: 'KILOGRAM' }],
    });
    const originalBatchId = (ingredient.batches as Array<Record<string, unknown>>)[0]!.id as string;

    const replaced = await call<Record<string, unknown>>(
      router,
      'PUT',
      `/api/v1/ingredients/${ingredient.id}`,
      {
        version: 1,
        name: '替换批次面粉',
        unit: 'KILOGRAM',
        batches: [
          { quantity: 250, unit: 'GRAM', opened: true },
          { quantity: 2, unit: 'KILOGRAM' },
        ],
      },
    );
    expect(replaced.status).toBe(200);
    expect(replaced.body.data).toMatchObject({ quantity: 2.25, opened: true, version: 2 });
    const activeBatches = replaced.body.data!.batches as Array<Record<string, unknown>>;
    expect(activeBatches).toHaveLength(2);
    expect(activeBatches.map((batch) => [batch.quantity, batch.unit])).toEqual(
      expect.arrayContaining([
        [250, 'GRAM'],
        [2, 'KILOGRAM'],
      ]),
    );

    // 旧批次软删而非物理删除：保留 InventoryLog 外键
    const [retired] = await db.query<{ deletedAt: string | null }>(
      'SELECT "deletedAt" FROM "InventoryBatch" WHERE "id" = ?',
      [originalBatchId],
    );
    expect(retired!.deletedAt).toBeTruthy();
    expect(await db.query('PRAGMA foreign_key_check')).toEqual([]);

    // 命令载荷按请求顺序固定新批次/日志 ID
    const rows = await outbox(db);
    const payload = JSON.parse(rows[1]!.payloadJson as string) as {
      executedAt: string;
      replacedBatches: Array<{ batchId: string; logId: string }>;
    };
    expect(payload.executedAt).toBe(NOW.toISOString());
    expect(payload.replacedBatches.map((ref) => ref.batchId).sort()).toEqual(
      activeBatches.map((batch) => batch.id).sort(),
    );
    const replacementLogs = await db.query<{ id: string }>(
      'SELECT "id" FROM "InventoryLog" WHERE "ingredientId" = ? AND "notes" = ? ORDER BY rowid',
      [String(ingredient.id), '食材编辑替换批次'],
    );
    expect(payload.replacedBatches.map((ref) => ref.logId)).toEqual(
      replacementLogs.map((log) => log.id),
    );
  });

  it('历史存量无活批次：编辑前自动补建等效批次并写 ADJUST', async () => {
    const { db, router } = harness;
    const ingredient = await create({ name: '历史存量糖', unit: 'GRAM' });
    // 模拟早期只写汇总、从未建批次的记录
    await db.withWriteTransaction(async (tx) => {
      await tx.run('UPDATE "Ingredient" SET "quantity" = 800 WHERE "id" = ?', [
        String(ingredient.id),
      ]);
    });
    expect(await batchRows(db, ingredient.id as string)).toHaveLength(0);

    const updated = await call<Record<string, unknown>>(
      router,
      'PUT',
      `/api/v1/ingredients/${ingredient.id}`,
      {
        version: 1,
        name: '历史存量糖',
        unit: 'GRAM',
        quantity: 1000,
      },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({ quantity: 1000, version: 2 });
    const batches = await batchRows(db, ingredient.id as string);
    // 补建的等效批次 createdAt 晚于随后追加的差额批次，这里只比较数量集合
    expect(batches.map((batch) => batch.quantity).sort((a, b) => a - b)).toEqual([200, 800]);
    const logs = await db.query<{ changeType: string; notes: string | null }>(
      'SELECT "changeType","notes" FROM "InventoryLog" WHERE "ingredientId" = ? ORDER BY rowid ASC',
      [String(ingredient.id)],
    );
    expect(logs.map((log) => log.changeType)).toEqual(['ADJUST', 'ADJUST']);
    expect(logs[0]!.notes).toBe('历史存量自动补建等效批次');
  });
});

describe('DELETE /api/v1/ingredients/:id', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness();
  });

  it('query version 必填；软删食材与批次并入队 delete', async () => {
    const { db, router } = harness;
    const created = await call<Record<string, unknown>>(router, 'POST', '/api/v1/ingredients', {
      name: '待删黄油',
      unit: 'GRAM',
      batches: [{ quantity: 200, unit: 'GRAM' }],
    });
    const id = created.body.data!.id as string;

    const noVersion = await call(router, 'DELETE', `/api/v1/ingredients/${id}`);
    expect(noVersion.status).toBe(400);

    const stale = await call(router, 'DELETE', `/api/v1/ingredients/${id}?version=2`);
    expect(stale.status).toBe(409);
    expect(stale.body.error?.code).toBe('VERSION_CONFLICT');

    const deleted = await call<{ id: string; deleted: boolean }>(
      router,
      'DELETE',
      `/api/v1/ingredients/${id}?version=1`,
    );
    expect(deleted.status).toBe(200);
    expect(deleted.body.data).toEqual({ id, deleted: true });

    const [ingredient] = await db.query<Record<string, unknown>>(
      'SELECT * FROM "Ingredient" WHERE "id" = ?',
      [id],
    );
    expect(ingredient!.deletedAt).toBeTruthy();
    expect(ingredient!.version).toBe(2);
    const batches = await db.query<Record<string, unknown>>(
      'SELECT * FROM "InventoryBatch" WHERE "ingredientId" = ?',
      [id],
    );
    expect(batches.every((batch) => batch.deletedAt !== null)).toBe(true);

    // 发件箱只需保证「最终语义是删除」：倒数第一条该实体操作必须是 delete
    const rows = await outbox(db);
    const last = rows.at(-1)!;
    expect(last).toMatchObject({ entity: 'Ingredient', entityId: id, kind: 'delete' });
    expect(last.baseVersion).toBe(1);
    const lastPayload = JSON.parse(last.payloadJson as string) as Record<string, unknown>;
    expect(lastPayload).toEqual({ deletedAt: NOW.toISOString() });
    // 不允许在 delete 之后还残留会复活该实体的 pending upsert
    expect(rows.every((row) => row.kind !== 'upsert' || rows.indexOf(row) < rows.length - 1)).toBe(
      true,
    );

    const gone = await call(router, 'GET', `/api/v1/ingredients/${id}`);
    expect(gone.status).toBe(404);
  });
});

describe('POST /api/v1/ingredients/:id/consume', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness();
  });

  async function seedMixed(): Promise<Record<string, unknown>> {
    const created = await call<Record<string, unknown>>(
      harness.router,
      'POST',
      '/api/v1/ingredients',
      {
        name: '消耗测试鸡胸肉',
        unit: 'GRAM',
        batches: [
          { quantity: 300, unit: 'GRAM', expiryDate: '2026-12-20' },
          { quantity: 500, unit: 'GRAM', expiryDate: '2026-12-01' },
          { quantity: 200, unit: 'GRAM', expiryDate: '2026-12-10', consumePriority: true },
        ],
      },
    );
    expect(created.status).toBe(201);
    return created.body.data as Record<string, unknown>;
  }

  it('QUANTITY：按 consumePriority → 到期日顺序扣减，写日志并只入队一条命令', async () => {
    const { db, router } = harness;
    const ingredient = await seedMixed();
    const id = ingredient.id as string;
    const before = await outbox(db);

    const result = await call<Record<string, unknown>>(
      router,
      'POST',
      `/api/v1/ingredients/${id}/consume`,
      {
        mode: 'QUANTITY',
        quantity: 450,
        unit: 'GRAM',
        ingredientVersion: 1,
      },
    );
    expect(result.status).toBe(200);
    const data = result.body.data as Record<string, unknown>;
    expect(data).toMatchObject({
      mode: 'QUANTITY',
      consumedQuantity: 450,
      consumedUnit: 'GRAM',
      incompatibleBatchIds: [],
    });
    const allocations = data.allocations as Array<Record<string, unknown>>;
    // 优先批次 200 全扣，然后最早到期 500 扣 250
    expect(
      allocations.map((item) => [item.beforeQuantity, item.changeQuantity, item.afterQuantity]),
    ).toEqual([
      [200, -200, 0],
      [500, -250, 250],
    ]);
    expect(data.ingredient).toMatchObject({ quantity: 550, version: 2, status: 'NORMAL' });
    expect((data.inventoryLogIds as unknown[]).length).toBe(2);

    const batches = await batchRows(db, id);
    expect(batches.map((batch) => batch.quantity)).toEqual([0, 250, 300]);
    const logs = await db.query<{ changeType: string; changeQuantity: number; unit: string }>(
      'SELECT "changeType","changeQuantity","unit" FROM "InventoryLog" WHERE "ingredientId" = ? AND "changeType" = ? ORDER BY rowid ASC',
      [id, 'MANUAL_DEDUCT'],
    );
    expect(logs.map((log) => log.changeQuantity)).toEqual([-200, -250]);

    const rows = await outbox(db);
    expect(rows.length).toBe(before.length + 1);
    expect(rows.at(-1)).toMatchObject({
      entity: 'Ingredient',
      entityId: id,
      kind: 'command',
      commandType: 'INGREDIENT_CONSUME',
      baseVersion: 1,
    });
    const payload = JSON.parse(rows.at(-1)!.payloadJson as string) as Record<string, unknown>;
    expect(payload).toMatchObject({
      id,
      baseVersion: 1,
      request: { mode: 'QUANTITY', quantity: 450, unit: 'GRAM', ingredientVersion: 1, notes: null },
    });
    expect(payload.executedAt).toBe(NOW.toISOString());
    // deductions 必须按实际扣减顺序映射明确 batchId 与已落库日志 ID
    const deductions = payload.deductions as Array<{
      batchId: string;
      logId: string;
      beforeQuantity: number;
      changeQuantity: number;
      afterQuantity: number;
    }>;
    const deducted = data.allocations as Array<Record<string, unknown>>;
    expect(
      deductions.map((item) => [item.batchId, item.beforeQuantity, item.changeQuantity]),
    ).toEqual(
      deducted.map((item) => [
        item.batchId as string,
        item.beforeQuantity as number,
        item.changeQuantity as number,
      ]),
    );
    const logRows = await db.query<{ id: string }>(
      'SELECT "id" FROM "InventoryLog" WHERE "ingredientId" = ? AND "changeType" = ? ORDER BY rowid',
      [id, 'MANUAL_DEDUCT'],
    );
    expect(deductions.map((item) => item.logId)).toEqual(logRows.map((row) => row.id));
    expect(payload.inventoryLogIds).toEqual(logRows.map((row) => row.id));
  });

  it('QUANTITY：可用量不足 → 409 且无任何写入/入队（不部分扣减）', async () => {
    const { db, router } = harness;
    const ingredient = await seedMixed();
    const id = ingredient.id as string;
    const before = await outbox(db);
    const logsBefore = await countLogs(db, id);

    const failed = await call(router, 'POST', `/api/v1/ingredients/${id}/consume`, {
      mode: 'QUANTITY',
      quantity: 1001,
      unit: 'GRAM',
      ingredientVersion: 1,
    });
    expect(failed.status).toBe(409);
    expect(failed.body.error?.code).toBe('CONFLICT');

    expect((await batchRows(db, id)).map((batch) => batch.quantity)).toEqual([200, 500, 300]);
    const [row] = await db.query<Record<string, unknown>>(
      'SELECT "quantity","version" FROM "Ingredient" WHERE "id" = ?',
      [id],
    );
    expect(row).toMatchObject({ quantity: 1000, version: 1 });
    expect(await countLogs(db, id)).toBe(logsBefore);
    expect(await outbox(db)).toEqual(before);
  });

  it('QUANTITY：单位不可换算 → 409；部分批次不可换算时在响应标出但只扣兼容批次', async () => {
    const { db, router } = harness;
    const piece = await call<Record<string, unknown>>(router, 'POST', '/api/v1/ingredients', {
      name: '不可换算鸡胸肉',
      unit: 'GRAM',
      batches: [{ quantity: 100, unit: 'GRAM' }],
    });
    const pieceId = piece.body.data!.id as string;
    // 直接插入一条计件批次，模拟历史脏数据（维度不同）
    await db.withWriteTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO "InventoryBatch" ("id","ingredientId","quantity","unit","version","createdAt","updatedAt")
         VALUES ('legacy-piece','${pieceId}',2,'PIECE',1,?,?)`,
        [NOW.toISOString(), NOW.toISOString()],
      );
    });

    const partial = await call<Record<string, unknown>>(
      router,
      'POST',
      `/api/v1/ingredients/${pieceId}/consume`,
      {
        mode: 'QUANTITY',
        quantity: 50,
        unit: 'GRAM',
        ingredientVersion: 1,
      },
    );
    expect(partial.status).toBe(200);
    expect(partial.body.data).toMatchObject({
      consumedQuantity: 50,
      incompatibleBatchIds: ['legacy-piece'],
    });
    expect(
      (await batchRows(db, pieceId)).find((batch) => batch.id === 'legacy-piece')!.quantity,
    ).toBe(2);

    const incompatible = await call(router, 'POST', `/api/v1/ingredients/${pieceId}/consume`, {
      mode: 'QUANTITY',
      quantity: 1,
      unit: 'LITER',
      ingredientVersion: 2,
    });
    expect(incompatible.status).toBe(409);
  });

  it('ALL：清零全部活批次，消耗量按食材基础单位汇总', async () => {
    const { db, router } = harness;
    const ingredient = await seedMixed();
    const id = ingredient.id as string;
    const result = await call<Record<string, unknown>>(
      router,
      'POST',
      `/api/v1/ingredients/${id}/consume`,
      {
        mode: 'ALL',
        ingredientVersion: 1,
        notes: '全部用完',
      },
    );
    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({
      mode: 'ALL',
      consumedQuantity: 1000,
      consumedUnit: 'GRAM',
      incompatibleBatchIds: [],
    });
    expect((result.body.data!.allocations as unknown[]).length).toBe(3);
    expect((await batchRows(db, id)).every((batch) => batch.quantity === 0)).toBe(true);
    expect(result.body.data!.ingredient).toMatchObject({
      quantity: 0,
      version: 2,
      status: 'DEPLETED',
    });
    const logs = await db.query<{ notes: string | null }>(
      'SELECT "notes" FROM "InventoryLog" WHERE "ingredientId" = ? AND "changeType" = ?',
      [id, 'MANUAL_DEDUCT'],
    );
    expect(logs.every((log) => log.notes === '全部用完')).toBe(true);
  });

  it('ALL 携带数量/单位 → 400；未知字段 → 400 fail-closed', async () => {
    const { router } = harness;
    const ingredient = await seedMixed();
    const id = ingredient.id as string;
    expect(
      (
        await call(router, 'POST', `/api/v1/ingredients/${id}/consume`, {
          mode: 'ALL',
          quantity: 1,
          ingredientVersion: 1,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(router, 'POST', `/api/v1/ingredients/${id}/consume`, {
          mode: 'ALL',
          ingredientVersion: 1,
          surprise: true,
        })
      ).status,
    ).toBe(400);
  });

  it('过期 ingredientVersion → 409 VERSION_CONFLICT，不产生写入', async () => {
    const { db, router } = harness;
    const ingredient = await seedMixed();
    const id = ingredient.id as string;
    const before = await outbox(db);
    const failed = await call(router, 'POST', `/api/v1/ingredients/${id}/consume`, {
      mode: 'QUANTITY',
      quantity: 10,
      unit: 'GRAM',
      ingredientVersion: 7,
    });
    expect(failed.status).toBe(409);
    expect(failed.body.error).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { entity: 'Ingredient', expectedVersion: 7, actualVersion: 1 },
    });
    expect(await outbox(db)).toEqual(before);
  });

  it('历史存量无活批次：先补建等效批次再扣减，ADJUST + MANUAL_DEDUCT 同事务', async () => {
    const { db, router } = harness;
    const created = await call<Record<string, unknown>>(router, 'POST', '/api/v1/ingredients', {
      name: '历史存量米',
      unit: 'GRAM',
    });
    const id = created.body.data!.id as string;
    await db.withWriteTransaction(async (tx) => {
      await tx.run('UPDATE "Ingredient" SET "quantity" = 600, "expiryDate" = ? WHERE "id" = ?', [
        '2026-12-31',
        String(id),
      ]);
    });
    expect(await batchRows(db, id)).toHaveLength(0);

    const result = await call<Record<string, unknown>>(
      router,
      'POST',
      `/api/v1/ingredients/${id}/consume`,
      {
        mode: 'QUANTITY',
        quantity: 100,
        unit: 'GRAM',
        ingredientVersion: 1,
      },
    );
    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({ consumedQuantity: 100, consumedUnit: 'GRAM' });
    const batches = await batchRows(db, id);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ quantity: 500, unit: 'GRAM', expiryDate: '2026-12-31' });
    const logs = await db.query<{ changeType: string; changeQuantity: number }>(
      'SELECT "changeType","changeQuantity" FROM "InventoryLog" WHERE "ingredientId" = ? ORDER BY rowid ASC',
      [id],
    );
    expect(logs.map((log) => [log.changeType, log.changeQuantity])).toEqual([
      ['ADJUST', 600],
      ['MANUAL_DEDUCT', -100],
    ]);
    expect(result.body.data!.ingredient).toMatchObject({ quantity: 500, version: 2 });
  });

  it('真实适配器链路：consumePresets 载荷（quantity+unit）可被本地实现接受', async () => {
    const { router } = harness;
    await seedMixed();
    const localFetch = createLocalApiFetch({ router, origin: ORIGIN });
    const adapter = loadGoogle2Adapter({ fetch: localFetch, origin: ORIGIN });
    adapter.storage.set(ADAPTER_PIN_KEY, TOKEN);

    const list = await adapter.api.get<{ items: Array<Record<string, unknown>> }>(
      '/ingredients?page=1&pageSize=100',
    );
    const item = list.items.find((entry) => entry.name === '消耗测试鸡胸肉')!;
    const result = await adapter.api.post<Record<string, unknown>>(
      `/ingredients/${encodeURIComponent(item.id as string)}/consume`,
      { mode: 'QUANTITY', quantity: 250, unit: 'GRAM', ingredientVersion: item.version },
    );
    expect(result.ingredient).toMatchObject({ quantity: 750, version: 2 });
  });

  it('批次版本作为第二层谓词：扣减后每个命中批次 version 递增', async () => {
    const { db, router } = harness;
    const ingredient = await seedMixed();
    const id = ingredient.id as string;
    await call(router, 'POST', `/api/v1/ingredients/${id}/consume`, {
      mode: 'QUANTITY',
      quantity: 450,
      unit: 'GRAM',
      ingredientVersion: 1,
    });
    const batches = await batchRows(db, id);
    // 命中两个批次各 +1，未命中批次保持 1
    expect(batches.map((batch) => batch.version)).toEqual([2, 2, 1]);
  });
});

describe('食材状态与本地日历', () => {
  it('同一 date 在本地日历下判定 EXPIRED/EXPIRING_SOON/DEPLETED', async () => {
    const harness = await createHarness();
    const { router } = harness;
    const make = async (name: string, expiryDate: string | null, quantity: number) =>
      (
        await call<Record<string, unknown>>(router, 'POST', '/api/v1/ingredients', {
          name,
          unit: 'GRAM',
          batches: [{ quantity, unit: 'GRAM', expiryDate }],
        })
      ).body.data!;

    const expired = await make('过期酸奶', '2026-11-20', 100);
    const today = await make('今日到期酸奶', TODAY, 100);
    const soon = await make('三日后到期酸奶', '2026-11-24', 100);
    const later = await make('远期酸奶', '2027-01-01', 100);
    const empty = await make('空袋盐', '2027-01-01', 0);

    expect(expired.status).toBe('EXPIRED');
    expect(today.status).toBe('EXPIRING_SOON');
    expect(soon.status).toBe('EXPIRING_SOON');
    expect(later.status).toBe('NORMAL');
    expect(empty.status).toBe('DEPLETED');
  });
});

describe('真实适配器请求序列（对齐 domain-api 集成断言）', () => {
  it('KILOGRAM 编辑重平衡、连续跨单位扣减、失败全量回滚、命令顺序与哈希', async () => {
    const { db, router } = await createHarness();
    const localFetch = createLocalApiFetch({ router, origin: ORIGIN });
    const adapter = loadGoogle2Adapter({ fetch: localFetch, origin: ORIGIN });
    adapter.storage.set(ADAPTER_PIN_KEY, TOKEN);
    const api = adapter.api;

    const created = await api.post<Record<string, unknown>>('/ingredients', {
      name: '大米',
      imagePath: null,
      category: null,
      unit: 'KILOGRAM',
      minStock: null,
      maxStock: null,
      notes: null,
      batches: [
        {
          quantity: 2,
          unit: 'KILOGRAM',
          purchaseDate: null,
          expiryDate: null,
          location: null,
          opened: false,
          consumePriority: true,
          notes: null,
        },
      ],
    });
    expect(created).toMatchObject({ quantity: 2, unit: 'KILOGRAM', version: 1, opened: false });
    const id = created.id as string;
    expect(await api.get(`/ingredients/${id}`)).toMatchObject({
      opened: false,
      batches: [{ opened: false, consumePriority: true }],
    });

    const edited = await api.put<Record<string, unknown>>(`/ingredients/${id}`, {
      name: '大米',
      imagePath: null,
      category: null,
      unit: 'KILOGRAM',
      minStock: null,
      maxStock: null,
      notes: null,
      version: 1,
      quantity: 1,
      location: '橱柜',
    });
    expect(edited).toMatchObject({ quantity: 1, version: 2 });
    expect(await api.get(`/ingredients/${id}`)).toMatchObject({
      quantity: 1,
      batches: [{ quantity: 1, location: '橱柜' }],
    });

    const first = await api.post<{ ingredient: Record<string, unknown> }>(
      `/ingredients/${id}/consume`,
      { mode: 'QUANTITY', quantity: 200, unit: 'GRAM', ingredientVersion: 2 },
    );
    const second = await api.post<{ ingredient: Record<string, unknown> }>(
      `/ingredients/${id}/consume`,
      { mode: 'QUANTITY', quantity: 250, unit: 'GRAM', ingredientVersion: 3 },
    );
    expect([first.ingredient.quantity, second.ingredient.quantity]).toEqual([0.8, 0.55]);

    const tables = ['Ingredient', 'InventoryBatch', 'InventoryLog', SYNC_OUTBOX_TABLE];
    const snapshot = () =>
      Promise.all(
        tables.map(
          async (table) =>
            [table, await db.query(`SELECT * FROM "${table}" ORDER BY rowid`)] as const,
        ),
      );
    const before = await snapshot();
    await expect(
      api.post(`/ingredients/${id}/consume`, {
        mode: 'QUANTITY',
        quantity: 551,
        unit: 'GRAM',
        ingredientVersion: 4,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      api.post(`/ingredients/${id}/consume`, {
        mode: 'QUANTITY',
        quantity: 1,
        unit: 'LITER',
        ingredientVersion: 4,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await snapshot()).toEqual(before);

    const rows = await db.query<{
      commandType: string;
      baseVersion: number;
      payloadJson: string;
      payloadHash: string;
    }>(
      `SELECT "commandType","baseVersion","payloadJson","payloadHash" FROM "${SYNC_OUTBOX_TABLE}" WHERE "kind" = ? ORDER BY rowid`,
      ['command'],
    );
    expect(rows.map((row) => [row.commandType, row.baseVersion])).toEqual([
      ['INGREDIENT_UPDATE_SYNC_BATCHES', 1],
      ['INGREDIENT_CONSUME', 2],
      ['INGREDIENT_CONSUME', 3],
    ]);
    for (const row of rows) {
      // 主代理数据库按 payload 自动生成 payloadHash：sha256(payloadJson 原文)
      expect(row.payloadHash).toEqual(createHash('sha256').update(row.payloadJson).digest('hex'));
    }

    const drained = await api.post<{ ingredient: Record<string, unknown> }>(
      `/ingredients/${id}/consume`,
      { mode: 'ALL', ingredientVersion: 4 },
    );
    expect(drained.ingredient).toMatchObject({ quantity: 0, status: 'DEPLETED' });
    expect((await db.query('PRAGMA foreign_key_check')) as unknown[]).toEqual([]);
  });

  it('adapter 分页遍历与 GET /:id 详情刷新', async () => {
    const { router } = await createHarness();
    const localFetch = createLocalApiFetch({ router, origin: ORIGIN });
    const adapter = loadGoogle2Adapter({ fetch: localFetch, origin: ORIGIN });
    adapter.storage.set(ADAPTER_PIN_KEY, TOKEN);
    const api = adapter.api;

    for (const name of ['A料', 'B料', 'C料']) {
      await api.post('/ingredients', {
        name,
        unit: 'GRAM',
        batches: [{ quantity: 10, unit: 'GRAM' }],
      });
    }
    const page = await api.get<{ items: unknown[]; total: number; totalPages: number }>(
      '/ingredients?page=1&pageSize=2',
    );
    expect(page).toMatchObject({ total: 3, totalPages: 2 });
    expect(page.items).toHaveLength(2);
    const page2 = await api.get<{ items: unknown[] }>('/ingredients?page=2&pageSize=2');
    expect(page2.items).toHaveLength(1);
  });
});
