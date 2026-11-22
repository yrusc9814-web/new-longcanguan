import { createHash } from 'node:crypto';
import { RETAINED_ENDPOINTS } from '@dafan/shared/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type DatabaseHandle } from '../src/db/database.js';
import { SYNC_OUTBOX_TABLE } from '../src/db/schema.js';
import {
  createLocalApiFetch,
  createLocalApiRouter,
  type LocalApiRouter,
} from '../src/local-api/index.js';
import { registerMealPlans } from '../src/modules/meal-plans/index.js';
import { completePlan, createPlan, uncompletePlan } from '../src/modules/meal-plans/service.js';
import { registerMealRecords } from '../src/modules/meal-records/index.js';
import { deleteRecord } from '../src/modules/meal-records/service.js';
import { registerRecipes } from '../src/modules/recipes/index.js';
import {
  cookCheckinRecipe,
  registerRecipeCookCheckin,
} from '../src/modules/recipes/cook-checkin.js';
import { createNodeSqliteDriver } from './helpers/node-sqlite-driver.js';
import { loadGoogle2Adapter } from './local-api-adapter-harness.js';

const ORIGIN = 'http://localhost';
const NOW = new Date('2026-11-21T08:00:00.000Z');
const TODAY = '2026-11-21';

interface JsonResult<T = Record<string, unknown>> {
  readonly status: number;
  readonly body: {
    success: boolean;
    data: T | null;
    error: { code: string; message: string; details?: Record<string, unknown> } | null;
  };
}

interface OutboxRow {
  readonly opId: string;
  readonly entity: string;
  readonly entityId: string;
  readonly kind: 'upsert' | 'delete' | 'command';
  readonly commandType: string | null;
  readonly baseVersion: number | null;
  readonly payloadJson: string | null;
  readonly payloadHash: string | null;
}

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
  const getDatabase = async () => db;
  registerRecipes(router, getDatabase);
  registerMealPlans(router, getDatabase);
  registerMealRecords(router, getDatabase);
  registerRecipeCookCheckin(router, getDatabase);
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
  return { status: response.status, body: (await response.json()) as JsonResult<T>['body'] };
}

async function outbox(db: DatabaseHandle): Promise<OutboxRow[]> {
  return db.query<OutboxRow>(
    `SELECT "opId","entity","entityId","kind","commandType","baseVersion","payloadJson","payloadHash"
     FROM "${SYNC_OUTBOX_TABLE}" ORDER BY rowid`,
  );
}

async function seedRecipe(db: DatabaseHandle, id = 'recipe-1', name = '番茄炒蛋'): Promise<void> {
  const timestamp = NOW.toISOString();
  await db.withWriteTransaction(async (tx) => {
    await tx.run(
      `INSERT INTO "Recipe" ("id","name","calories","version","createdAt","updatedAt")
       VALUES (?,?,320,1,?,?)`,
      [id, name, timestamp, timestamp],
    );
  });
}

async function seedDiner(db: DatabaseHandle, id = 'diner-1', name = '甲'): Promise<void> {
  const timestamp = NOW.toISOString();
  await db.withWriteTransaction(async (tx) => {
    await tx.run(
      `INSERT INTO "Diner" ("id","name","active","version","createdAt","updatedAt")
       VALUES (?,?,1,1,?,?)`,
      [id, name, timestamp, timestamp],
    );
  });
}

function commandRows(rows: readonly OutboxRow[]): OutboxRow[] {
  return rows.filter((row) => row.kind === 'command');
}

async function seedStore(db: DatabaseHandle, id = 'store-1', name = '小馆'): Promise<void> {
  const timestamp = NOW.toISOString();
  await db.withWriteTransaction(async (tx) => {
    await tx.run(
      `INSERT INTO "Store" ("id","name","supportsDineIn","supportsTakeout","version","createdAt","updatedAt")
       VALUES (?,?,1,0,1,?,?)`,
      [id, name, timestamp, timestamp],
    );
  });
}

async function seedUploadAsset(
  db: DatabaseHandle,
  filename = 'main-abc.webp',
  options: { readonly deletedAt?: string | null } = {},
): Promise<string> {
  const timestamp = NOW.toISOString();
  await db.withWriteTransaction(async (tx) => {
    await tx.run(
      `INSERT INTO "UploadAsset"
        ("id","filename","storagePath","thumbnailPath","mimeType","sizeBytes","sha256","deletedAt","createdAt","updatedAt")
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        `asset-${filename}`,
        filename,
        filename,
        null,
        'image/webp',
        128,
        'f'.repeat(64),
        options.deletedAt ?? null,
        timestamp,
        timestamp,
      ],
    );
  });
  return `/uploads/${filename}`;
}

describe('T-004 A：排餐 / 记录 / 菜谱打卡与确定性同步命令', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  it('AC1：plans 6 条、records 6 条、cook-checkin 1 条全部注册且非 501 占位', async () => {
    const expected = RETAINED_ENDPOINTS.filter(
      (entry) => ['plan', 'record'].includes(entry.domain) || entry.path.endsWith('/cook-checkin'),
    );
    expect(expected).toHaveLength(13);
    for (const { method, path } of expected) {
      expect(harness.router.has(method, path), `${method} ${path}`).toBe(true);
    }

    // 未实现占位会返回 501；这里逐条确认命中的是真实处理器（参数不存在时应当是业务错误）。
    const probes: ReadonlyArray<[string, string]> = [
      ['GET', '/api/v1/plans'],
      ['POST', '/api/v1/plans'],
      ['PUT', '/api/v1/plans/p1'],
      ['DELETE', '/api/v1/plans/p1?version=1'],
      ['POST', '/api/v1/plans/p1/complete'],
      ['POST', '/api/v1/plans/p1/uncomplete'],
      ['GET', '/api/v1/records'],
      ['POST', '/api/v1/records'],
      ['GET', '/api/v1/records/r1'],
      ['PUT', '/api/v1/records/r1'],
      ['DELETE', '/api/v1/records/r1?version=1'],
      ['POST', '/api/v1/records/r1/confirm'],
      ['POST', '/api/v1/recipes/r1/cook-checkin'],
    ];
    for (const [method, path] of probes) {
      const result = await call(harness.router, method, path, method === 'GET' ? undefined : {});
      expect(result.status, `${method} ${path}`).not.toBe(501);
    }
  });

  it('排餐 CRUD：墓碑行保留原 ID，同日同餐只拦活跃计划', async () => {
    const { router, db } = harness;
    const created = await call<Record<string, unknown>>(router, 'POST', '/api/v1/plans', {
      planDate: TODAY,
      mealType: 'LUNCH',
      dinerCount: 2,
      time: '12:30',
      title: '番茄炒蛋',
      items: [{ itemType: 'CUSTOM', customName: '番茄炒蛋' }],
    });
    expect(created.status).toBe(201);
    const plan = created.body.data!;
    expect(plan).toMatchObject({ status: 'PLANNED', version: 1, dinerCount: 2, time: '12:30' });

    const conflict = await call(router, 'POST', '/api/v1/plans', {
      planDate: TODAY,
      mealType: 'LUNCH',
      dinerCount: 2,
      items: [{ itemType: 'CUSTOM', customName: '另一份' }],
    });
    expect(conflict.status).toBe(409);

    const updated = await call<Record<string, unknown>>(
      router,
      'PUT',
      `/api/v1/plans/${plan.id as string}`,
      { version: 1, title: '改期前', planDate: '2026-11-22' },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({ planDate: '2026-11-22', version: 2 });

    const removed = await call(router, 'DELETE', `/api/v1/plans/${plan.id as string}?version=2`);
    expect(removed.status).toBe(200);

    const revived = await call<Record<string, unknown>>(router, 'POST', '/api/v1/plans', {
      planDate: '2026-11-22',
      mealType: 'LUNCH',
      dinerCount: 1,
      items: [{ itemType: 'CUSTOM', customName: '新计划' }],
    });
    expect(revived.status).toBe(201);
    expect(revived.body.data!.id).not.toBe(plan.id);
    expect(revived.body.data).toMatchObject({ version: 1, status: 'PLANNED' });

    const tombstone = await db.query<{ id: string; deletedAt: string | null }>(
      `SELECT "id","deletedAt" FROM "MealPlan" WHERE "id" = ?`,
      [plan.id as string],
    );
    expect(tombstone[0]?.deletedAt).toBe(NOW.toISOString());

    const plans = await call<unknown[]>(router, 'GET', '/api/v1/plans');
    expect(plans.body.data).toHaveLength(1);
    expect(await db.query('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('完成计划生成 DRAFT 并固化确定性事实与 payloadHash，重复完成幂等', async () => {
    const { router, db } = harness;
    await seedRecipe(db);
    await seedDiner(db);

    const created = await call<Record<string, unknown>>(router, 'POST', '/api/v1/plans', {
      planDate: TODAY,
      mealType: 'LUNCH',
      dinerCount: 1,
      items: [{ itemType: 'RECIPE', recipeId: 'recipe-1', mealRole: 'MAIN' }],
      dinerIds: ['diner-1'],
    });
    const planId = created.body.data!.id as string;

    const completed = await call<Record<string, unknown>>(
      router,
      'POST',
      `/api/v1/plans/${planId}/complete`,
      { version: 1 },
    );
    expect(completed.status).toBe(200);
    const data = completed.body.data!;
    expect(data.idempotent).toBe(false);
    expect(data.plan).toMatchObject({ status: 'COMPLETED', version: 2 });
    const record = data.record as {
      id: string;
      status: string;
      sourceMealPlanId: string;
      relatedPlanId: string;
      items: Array<{ id: string }>;
    };
    expect(record).toMatchObject({
      status: 'DRAFT',
      sourceMealPlanId: planId,
      relatedPlanId: planId,
    });

    const [stored] = await db.query<{ id: string; mealType: string; sourceType: string }>(
      `SELECT "id","mealType","sourceType" FROM "MealRecord" WHERE "sourceMealPlanId" = ?`,
      [planId],
    );
    expect(stored).toMatchObject({ id: record.id, mealType: 'LUNCH', sourceType: 'HOMEMADE' });
    expect(await db.query('SELECT "id" FROM "MealRecordItem"')).toHaveLength(1);

    const rows = commandRows(await outbox(db));
    expect(rows.map((row) => [row.entity, row.commandType, row.baseVersion])).toEqual([
      ['MealPlan', 'PLAN_COMPLETE', 1],
    ]);
    const payload = JSON.parse(rows[0]!.payloadJson as string);
    expect(payload).toMatchObject({
      id: planId,
      baseVersion: 1,
      executedAt: NOW.toISOString(),
      recordCreated: true,
      recordRevived: false,
      inventoryDeductionPromptEnabled: false,
      plan: { id: planId, status: 'COMPLETED', version: 2 },
      record: {
        id: record.id,
        status: 'DRAFT',
        sourceMealPlanId: planId,
        version: 1,
        confirmedAt: null,
        itemIds: expect.any(Array),
        dinerRowIds: expect.any(Array),
      },
    });
    expect(payload.record.itemIds).toEqual(
      (await db.query<{ id: string }>('SELECT "id" FROM "MealRecordItem"')).map((row) => row.id),
    );
    expect(payload.record.dinerRowIds).toEqual(
      (await db.query<{ id: string }>('SELECT "id" FROM "MealRecordDiner"')).map((row) => row.id),
    );
    expect(rows[0]!.payloadHash).toBe(
      createHash('sha256')
        .update(rows[0]!.payloadJson as string)
        .digest('hex'),
    );

    const repeated = await call<Record<string, unknown>>(
      router,
      'POST',
      `/api/v1/plans/${planId}/complete`,
      { version: 2 },
    );
    expect(repeated.status).toBe(200);
    expect(repeated.body.data).toMatchObject({ idempotent: true });
    expect(commandRows(await outbox(db))).toHaveLength(1);
  });

  it('撤销完成写入 provenance 快照，再完成复活草稿并清空 proof', async () => {
    const { router, db } = harness;
    await seedRecipe(db);
    const created = await call<Record<string, unknown>>(router, 'POST', '/api/v1/plans', {
      planDate: TODAY,
      mealType: 'DINNER',
      dinerCount: 1,
      items: [{ itemType: 'RECIPE', recipeId: 'recipe-1' }],
    });
    const planId = created.body.data!.id as string;
    const completed = await call<Record<string, unknown>>(
      router,
      'POST',
      `/api/v1/plans/${planId}/complete`,
      { version: 1 },
    );
    const recordId = (completed.body.data!.record as { id: string }).id;

    const reverted = await call<Record<string, unknown>>(
      router,
      'POST',
      `/api/v1/plans/${planId}/uncomplete`,
      { version: 2 },
    );
    expect(reverted.status).toBe(200);
    expect(reverted.body.data!.plan).toMatchObject({ status: 'PLANNED', version: 3 });
    expect(reverted.body.data!.removedRecord).toEqual({ id: recordId });

    const [tombstone] = await db.query<{
      deletedAt: string | null;
      version: number;
      planUncompleteProof: string | null;
    }>(`SELECT "deletedAt","version","planUncompleteProof" FROM "MealRecord" WHERE "id" = ?`, [
      recordId,
    ]);
    expect(tombstone?.deletedAt).toBe(NOW.toISOString());
    expect(tombstone?.version).toBe(2);
    const proof = JSON.parse(tombstone!.planUncompleteProof as string);
    expect(proof).toMatchObject({
      origin: 'PLAN_UNCOMPLETE',
      sourcePlanId: planId,
      sourceRecordId: recordId,
      sourcePlanVersion: 2,
      sourceRecordVersion: 2,
      snapshot: {
        recordDate: TODAY,
        mealType: 'DINNER',
        sourceType: 'HOMEMADE',
        relatedPlanId: planId,
        sourceMealPlanId: planId,
        status: 'DRAFT',
      },
    });
    expect(proof.snapshot.items).toEqual([
      {
        itemType: 'RECIPE',
        mealRole: null,
        recipeId: 'recipe-1',
        storeId: null,
        customName: null,
        sortOrder: 0,
      },
    ]);

    const rows = commandRows(await outbox(db));
    expect(rows.map((row) => row.commandType)).toEqual(['PLAN_COMPLETE', 'PLAN_UNCOMPLETE']);
    const payload = JSON.parse(rows[1]!.payloadJson as string);
    expect(payload.removedRecord).toEqual({
      id: recordId,
      version: 2,
      deletedAt: NOW.toISOString(),
      planUncompleteProof: tombstone!.planUncompleteProof,
    });
    expect(rows[1]!.payloadHash).toBe(
      createHash('sha256')
        .update(rows[1]!.payloadJson as string)
        .digest('hex'),
    );

    const redo = await call<Record<string, unknown>>(
      router,
      'POST',
      `/api/v1/plans/${planId}/complete`,
      { version: 3 },
    );
    expect(redo.status).toBe(200);
    expect(redo.body.data!.record).toMatchObject({
      id: recordId,
      status: 'DRAFT',
      deletedAt: null,
      sourceMealPlanId: planId,
      version: 3,
    });
    const [revived] = await db.query<{
      planUncompleteProof: string | null;
      deletedAt: string | null;
    }>(`SELECT "planUncompleteProof","deletedAt" FROM "MealRecord" WHERE "id" = ?`, [recordId]);
    expect(revived).toEqual({ planUncompleteProof: null, deletedAt: null });
    const third = JSON.parse(commandRows(await outbox(db))[2]!.payloadJson as string);
    expect(third).toMatchObject({ recordCreated: false, recordRevived: true });
    expect(third.record.id).toBe(recordId);
    expect(await db.query('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('记录被用户编辑后撤销完成返回 409，且不留任何写入', async () => {
    const { router, db } = harness;
    await seedRecipe(db);
    const created = await call<Record<string, unknown>>(router, 'POST', '/api/v1/plans', {
      planDate: TODAY,
      mealType: 'BREAKFAST',
      dinerCount: 1,
      items: [{ itemType: 'RECIPE', recipeId: 'recipe-1' }],
    });
    const planId = created.body.data!.id as string;
    const completed = await call<Record<string, unknown>>(
      router,
      'POST',
      `/api/v1/plans/${planId}/complete`,
      { version: 1 },
    );
    const recordId = (completed.body.data!.record as { id: string }).id as string;
    const edited = await call(router, 'PUT', `/api/v1/records/${recordId}`, {
      version: 1,
      title: '用户改过',
    });
    expect(edited.status).toBe(200);

    const before = await outbox(db);
    const reverted = await call(router, 'POST', `/api/v1/plans/${planId}/uncomplete`, {
      version: 2,
    });
    expect(reverted.status).toBe(409);
    expect(await outbox(db)).toEqual(before);
    const [plan] = await db.query<{ status: string; version: number }>(
      `SELECT "status","version" FROM "MealPlan" WHERE "id" = ?`,
      [planId],
    );
    expect(plan).toEqual({ status: 'COMPLETED', version: 2 });
  });

  it('普通删除记录：软删 + sourceMealPlanId 置空 + 同事务回退计划，命令载荷可重放', async () => {
    const { router, db } = harness;
    await seedRecipe(db);
    const created = await call<Record<string, unknown>>(router, 'POST', '/api/v1/plans', {
      planDate: TODAY,
      mealType: 'LUNCH',
      dinerCount: 3,
      items: [{ itemType: 'RECIPE', recipeId: 'recipe-1' }],
    });
    const planId = created.body.data!.id as string;
    const completed = await call<Record<string, unknown>>(
      router,
      'POST',
      `/api/v1/plans/${planId}/complete`,
      { version: 1 },
    );
    const recordId = (completed.body.data!.record as { id: string }).id as string;

    const removed = await call<Record<string, unknown>>(
      router,
      'DELETE',
      `/api/v1/records/${recordId}?version=1`,
    );
    expect(removed.status).toBe(200);
    expect(removed.body.data).toEqual({ id: recordId, revertedPlanId: planId });

    const [record] = await db.query<{
      deletedAt: string | null;
      sourceMealPlanId: string | null;
      version: number;
    }>(`SELECT "deletedAt","sourceMealPlanId","version" FROM "MealRecord" WHERE "id" = ?`, [
      recordId,
    ]);
    expect(record).toEqual({ deletedAt: NOW.toISOString(), sourceMealPlanId: null, version: 2 });
    const [plan] = await db.query<{ status: string; completedAt: string | null; version: number }>(
      `SELECT "status","completedAt","version" FROM "MealPlan" WHERE "id" = ?`,
      [planId],
    );
    expect(plan).toEqual({ status: 'PLANNED', completedAt: null, version: 3 });

    const rows = commandRows(await outbox(db));
    expect(rows.map((row) => row.commandType)).toEqual(['PLAN_COMPLETE', 'RECORD_DELETE']);
    const payload = JSON.parse(rows[1]!.payloadJson as string);
    expect(payload).toMatchObject({
      id: recordId,
      baseVersion: 1,
      executedAt: NOW.toISOString(),
      deletedAt: NOW.toISOString(),
      releasedSourceMealPlanId: planId,
      revertedPlan: { id: planId, status: 'PLANNED', completedAt: null, version: 3 },
    });
    expect(rows[1]!.payloadHash).toBe(
      createHash('sha256')
        .update(rows[1]!.payloadJson as string)
        .digest('hex'),
    );

    // 计划回退后可重新完成：新草稿复用同一来源关联，命令载荷带真实 ID。
    const redo = await call<Record<string, unknown>>(
      router,
      'POST',
      `/api/v1/plans/${planId}/complete`,
      { version: 3 },
    );
    expect(redo.status).toBe(200);
    expect((redo.body.data!.record as { id: string }).id).not.toBe(recordId);
    expect(await db.query('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('菜谱直接打卡：新建 201、幂等 200、异内容 409，且不扣库存', async () => {
    const { router, db } = harness;
    await seedRecipe(db);
    const body = {
      recordDate: TODAY,
      mealType: 'LUNCH',
      rating: 5,
      satiety: 8,
      calories: 500,
      notes: '好吃',
    };
    const first = await call<Record<string, unknown>>(
      router,
      'POST',
      '/api/v1/recipes/recipe-1/cook-checkin',
      body,
    );
    expect(first.status).toBe(201);
    const record = first.body.data!.record as {
      id: string;
      status: string;
      calories: number;
      items: Array<{ id: string; recipeId: string }>;
    };
    expect(first.body.data).toMatchObject({ repeated: false, inventoryDeducted: false });
    expect(record).toMatchObject({ status: 'CONFIRMED', calories: 500 });
    expect(record.items).toEqual([expect.objectContaining({ recipeId: 'recipe-1' })]);

    const again = await call<Record<string, unknown>>(
      router,
      'POST',
      '/api/v1/recipes/recipe-1/cook-checkin',
      body,
    );
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ repeated: true });
    expect((again.body.data!.record as { id: string }).id).toBe(record.id);
    expect(await db.query('SELECT "id" FROM "MealRecord"')).toHaveLength(1);

    const mismatch = await call(router, 'POST', '/api/v1/recipes/recipe-1/cook-checkin', {
      ...body,
      notes: '内容不同',
    });
    expect(mismatch.status).toBe(409);
    expect(await db.query('SELECT "id" FROM "MealRecord"')).toHaveLength(1);
    expect(await db.query('SELECT "id" FROM "InventoryLog"')).toEqual([]);

    const rows = commandRows(await outbox(db));
    expect(rows.map((row) => [row.entity, row.commandType, row.baseVersion])).toEqual([
      ['MealRecord', 'RECIPE_COOK_CHECKIN', null],
    ]);
    const payload = JSON.parse(rows[0]!.payloadJson as string);
    expect(payload).toMatchObject({
      id: record.id,
      baseVersion: null,
      recipeId: 'recipe-1',
      record: { id: record.id, status: 'CONFIRMED', version: 1 },
      request: { calories: 500, rating: 5, satiety: 8, notes: '好吃', sourceType: 'HOMEMADE' },
    });
    expect(payload.record.itemIds).toEqual(record.items.map((item) => item.id));
    expect(rows[0]!.payloadHash).toBe(
      createHash('sha256')
        .update(rows[0]!.payloadJson as string)
        .digest('hex'),
    );

    const unknownField = await call(router, 'POST', '/api/v1/recipes/recipe-1/cook-checkin', {
      recordDate: '2026-11-22',
      mealType: 'LUNCH',
      inventoryDeducted: true,
    });
    expect(unknownField.status).toBe(400);
  });

  it('records CRUD 与统计口径：分页、过滤、PUT 保留未提供字段', async () => {
    const { router, db } = harness;
    const created = await call<Record<string, unknown>>(router, 'POST', '/api/v1/records', {
      recordDate: TODAY,
      mealType: 'LUNCH',
      sourceType: 'TAKEOUT',
      title: '楼下盖饭',
      cost: 25,
      items: [{ itemType: 'CUSTOM', customName: '楼下盖饭' }],
    });
    expect(created.status).toBe(201);
    const id = created.body.data!.id as string;

    const listed = await call<Record<string, unknown>>(
      router,
      'GET',
      '/api/v1/records?page=1&pageSize=10',
    );
    expect(listed.body.data).toMatchObject({ total: 1, totalPages: 1 });

    const updated = await call<Record<string, unknown>>(router, 'PUT', `/api/v1/records/${id}`, {
      version: 1,
      notes: '有点咸',
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({
      title: '楼下盖饭',
      cost: 25,
      notes: '有点咸',
      version: 2,
    });

    const [row] = await db.query<{ photosJson: string | null; cost: number }>(
      `SELECT "photosJson","cost" FROM "MealRecord" WHERE "id" = ?`,
      [id],
    );
    expect(row).toEqual({ photosJson: null, cost: 25 });

    const upserts = (await outbox(db)).filter((entry) => entry.entity === 'MealRecord');
    expect(upserts.map((entry) => [entry.kind, entry.baseVersion])).toEqual([
      ['upsert', null],
      ['upsert', 1],
    ]);

    const invalid = await call(router, 'POST', '/api/v1/records', {
      recordDate: '2026-02-31',
      mealType: 'LUNCH',
      sourceType: 'TAKEOUT',
      items: [{ itemType: 'CUSTOM', customName: 'x' }],
    });
    expect(invalid.status).toBe(400);

    // PUT 与 POST 同一校验口径：非法饱和/未知字段/非法 minRating 均 400 且不写库。
    const beforeInvalid = await outbox(db);
    for (const body of [
      { version: 2, satiety: 4 },
      { version: 2, rating: 6 },
      { version: 2, additionalField: true },
      { version: 2, items: [{ itemType: 'RECIPE', customName: 'x' }] },
    ]) {
      const result = await call(router, 'PUT', `/api/v1/records/${id}`, body);
      expect(result.status, JSON.stringify(body)).toBe(400);
    }
    expect(await outbox(db)).toEqual(beforeInvalid);
    for (const query of [
      '?minRating=9',
      '?minRating=abc',
      '?status=UNKNOWN',
      '?mealType=MIDNIGHT',
    ]) {
      const result = await call(router, 'GET', `/api/v1/records${query}`);
      expect(result.status, query).toBe(400);
    }
  });

  it('服务端重放模拟：四类命令按 FIFO 顺序消费后与本地最终状态一致', async () => {
    const { router, db } = harness;
    await seedRecipe(db);
    const plan = await call<Record<string, unknown>>(router, 'POST', '/api/v1/plans', {
      planDate: TODAY,
      mealType: 'LUNCH',
      dinerCount: 1,
      items: [{ itemType: 'RECIPE', recipeId: 'recipe-1' }],
    });
    const planId = plan.body.data!.id as string;
    const completed = await call<Record<string, unknown>>(
      router,
      'POST',
      `/api/v1/plans/${planId}/complete`,
      { version: 1 },
    );
    const recordId = (completed.body.data!.record as { id: string }).id as string;
    await call(router, 'POST', `/api/v1/plans/${planId}/uncomplete`, { version: 2 });
    await call(router, 'POST', `/api/v1/plans/${planId}/complete`, { version: 3 });
    await call(router, 'DELETE', `/api/v1/records/${recordId}?version=3`);
    await call(router, 'POST', '/api/v1/recipes/recipe-1/cook-checkin', {
      recordDate: TODAY,
      mealType: 'DINNER',
    });

    const rows = await outbox(db);
    expect(rows.map((row) => [row.entity, row.kind, row.commandType, row.baseVersion])).toEqual([
      ['MealPlan', 'upsert', null, null],
      ['MealPlan', 'command', 'PLAN_COMPLETE', 1],
      ['MealPlan', 'command', 'PLAN_UNCOMPLETE', 2],
      ['MealPlan', 'command', 'PLAN_COMPLETE', 3],
      ['MealRecord', 'command', 'RECORD_DELETE', 3],
      ['MealRecord', 'command', 'RECIPE_COOK_CHECKIN', null],
    ]);

    // 服务端按 rowid 顺序重放：命令的 baseVersion 必须等于该实体当前版本。
    const versions = new Map<string, number>();
    for (const row of rows) {
      const scope = `${row.entity}:${row.entityId}`;
      const current = versions.get(scope) ?? 0;
      const payload = JSON.parse(row.payloadJson as string);
      if (row.payloadHash !== null) {
        expect(row.payloadHash).toBe(
          createHash('sha256')
            .update(row.payloadJson as string)
            .digest('hex'),
        );
      }
      if (row.kind === 'upsert') {
        if (row.baseVersion === null) {
          expect(versions.has(scope), `${scope} 只能新建一次`).toBe(false);
          versions.set(scope, payload.version ?? 1);
        } else {
          expect(row.baseVersion).toBe(current);
          versions.set(scope, current + 1);
        }
        continue;
      }
      if (row.commandType === 'PLAN_COMPLETE') {
        expect(row.entity).toBe('MealPlan');
        expect(row.baseVersion).toBe(current);
        expect(payload.record.sourceMealPlanId).toBe(row.entityId);
        expect(payload.record.status).toBe('DRAFT');
        // 记录由命令内嵌创建/复活：服务端复用同一 ID 与该行真实版本。
        versions.set(`MealRecord:${payload.record.id}`, payload.record.version as number);
        versions.set(scope, current + 1);
      } else if (row.commandType === 'PLAN_UNCOMPLETE') {
        expect(row.baseVersion).toBe(current);
        const proof = JSON.parse(payload.removedRecord.planUncompleteProof);
        expect(proof.sourcePlanId).toBe(row.entityId);
        expect(payload.removedRecord.deletedAt).toBe(payload.executedAt);
        versions.set(
          `MealRecord:${payload.removedRecord.id}`,
          payload.removedRecord.version as number,
        );
        versions.set(scope, current + 1);
      } else if (row.commandType === 'RECORD_DELETE') {
        expect(row.baseVersion).toBe(current);
        expect(payload.releasedSourceMealPlanId).toBe(planId);
        expect(payload.revertedPlan).toMatchObject({ id: planId, status: 'PLANNED' });
        versions.set(scope, current + 1);
        versions.set(`MealPlan:${planId}`, payload.revertedPlan.version as number);
      } else {
        expect(row.commandType).toBe('RECIPE_COOK_CHECKIN');
        expect(row.baseVersion).toBeNull();
        expect(payload.record.itemIds).toHaveLength(1);
        versions.set(scope, payload.record.version as number);
      }
    }

    const [localPlan] = await db.query<{ status: string; version: number }>(
      `SELECT "status","version" FROM "MealPlan" WHERE "id" = ?`,
      [planId],
    );
    expect(localPlan).toEqual({ status: 'PLANNED', version: 5 });
    expect(versions.get(`MealPlan:${planId}`)).toBe(5);
    const [localRecord] = await db.query<{ deletedAt: string | null; version: number }>(
      `SELECT "deletedAt","version" FROM "MealRecord" WHERE "id" = ?`,
      [recordId],
    );
    expect(localRecord?.deletedAt).toBe(NOW.toISOString());
    expect(versions.get(`MealRecord:${recordId}`)).toBe(localRecord?.version);
    expect(await db.query('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('真实适配器链路：排餐打卡/撤销、日记增改删确认、菜谱直接打卡均落本地库', async () => {
    const { router, db } = harness;
    await seedRecipe(db);
    const localFetch = createLocalApiFetch({ router, origin: ORIGIN });
    const adapter = loadGoogle2Adapter({ fetch: localFetch, origin: ORIGIN });
    const domain = adapter.window.DafanDomainAdapter as {
      replacePlanService(service: { data: Array<Record<string, unknown>> }): void;
      replaceRecordService(service: { data: Array<Record<string, unknown>> }): void;
    };
    const planService: Record<string, unknown> & { data: Array<{ id: string; version: number }> } =
      {
        data: [],
      };
    const recordService: Record<string, unknown> & {
      data: Array<{ id: string; version: number }>;
    } = {
      data: [],
    };
    domain.replacePlanService(planService);
    domain.replaceRecordService(recordService);
    // 适配器通过 window.BentoService 回写记录缓存；测试里等价挂载同一份服务对象。
    adapter.window.BentoService = { records: recordService, plans: planService };

    const plans = planService as unknown as {
      add(plan: Record<string, unknown>): Promise<boolean>;
      checkin(id: string): Promise<{ id: string; isCompleted: boolean }>;
      uncheckin(id: string): Promise<{ id: string; isCompleted: boolean }>;
      delete(id: string): Promise<void>;
    };
    expect(
      await plans.add({
        date: TODAY,
        slot: '午餐',
        time: '12:30',
        title: '番茄炒蛋',
        targetType: 'recipe',
        targetId: 'recipe-1',
      }),
    ).toBe(true);
    const planId = planService.data[0]!.id;
    expect(planService.data[0]).toMatchObject({ isCompleted: false, date: TODAY, slot: '午餐' });

    const completed = await plans.checkin(planId);
    expect(completed).toMatchObject({ id: planId, isCompleted: true });
    expect(recordService.data).toHaveLength(1);
    expect(recordService.data[0]).toMatchObject({ status: 'DRAFT', sourceMealPlanId: planId });

    const reverted = await plans.uncheckin(planId);
    expect(reverted).toMatchObject({ id: planId, isCompleted: false });
    expect(recordService.data).toHaveLength(0);

    await plans.delete(planId);
    expect(planService.data).toHaveLength(0);

    const records = recordService as unknown as {
      add(record: Record<string, unknown>): Promise<{ id: string; version: number }>;
      update(id: string, updates: Record<string, unknown>): Promise<{ id: string }>;
      confirm(id: string): Promise<{ id: string; status: string }>;
      delete(id: string): Promise<void>;
    };
    const added = await records.add({
      date: TODAY,
      slot: '晚餐',
      type: '外卖',
      title: '牛肉面',
      cost: 32,
      satiety: 8,
    });
    expect(added).toMatchObject({ status: 'CONFIRMED' });
    expect(recordService.data).toHaveLength(1);

    const edited = await records.update(added.id, { notes: '汤好喝' });
    expect(edited).toMatchObject({ id: added.id, notes: '汤好喝' });
    const confirmed = await records.confirm(added.id);
    expect(confirmed).toMatchObject({ id: added.id, status: 'CONFIRMED' });
    await records.delete(added.id);
    expect(recordService.data).toHaveLength(0);

    const cook = await adapter.api.post<Record<string, unknown>>('/recipes/recipe-1/cook-checkin', {
      recordDate: TODAY,
      mealType: 'BREAKFAST',
      rating: 3,
      satiety: 3,
    });
    expect(cook).toMatchObject({
      repeated: false,
      inventoryDeducted: false,
      record: { status: 'CONFIRMED', mealType: 'BREAKFAST' },
    });
    const rows = await outbox(db);
    expect(
      rows.filter((row) => row.kind === 'command').map((row) => [row.entity, row.commandType]),
    ).toEqual([
      ['MealPlan', 'PLAN_COMPLETE'],
      ['MealPlan', 'PLAN_UNCOMPLETE'],
      ['MealRecord', 'RECORD_DELETE'],
      ['MealRecord', 'RECIPE_COOK_CHECKIN'],
    ]);
    for (const row of rows.filter((entry) => entry.kind === 'command')) {
      expect(row.payloadHash).toBe(
        createHash('sha256')
          .update(row.payloadJson as string)
          .digest('hex'),
      );
    }
    expect(await db.query('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('T-004b：撤销后改计划（菜品↔探店、餐次/日期/人数/就餐人）仍复活同一草稿', async () => {
    const { router, db } = harness;
    await seedRecipe(db);
    await seedStore(db);
    await seedDiner(db, 'diner-1', '甲');
    await seedDiner(db, 'diner-2', '乙');

    const created = await call<Record<string, unknown>>(router, 'POST', '/api/v1/plans', {
      planDate: TODAY,
      mealType: 'LUNCH',
      dinerCount: 1,
      items: [{ itemType: 'RECIPE', recipeId: 'recipe-1', mealRole: 'MAIN' }],
      dinerIds: ['diner-1'],
    });
    const planId = created.body.data!.id as string;
    const first = await call<Record<string, unknown>>(
      router,
      'POST',
      `/api/v1/plans/${planId}/complete`,
      { version: 1 },
    );
    const recordId = (first.body.data!.record as { id: string }).id as string;

    const reverted = await call<Record<string, unknown>>(
      router,
      'POST',
      `/api/v1/plans/${planId}/uncomplete`,
      { version: 2 },
    );
    expect(reverted.status).toBe(200);
    const revertedVersion = (reverted.body.data!.plan as { version: number }).version;

    // 撤销后把计划整体改成「探店 + 换餐次/日期/人数/就餐人」。
    const changed = await call<Record<string, unknown>>(router, 'PUT', `/api/v1/plans/${planId}`, {
      version: revertedVersion,
      planDate: '2026-11-22',
      mealType: 'DINNER',
      dinerCount: 2,
      items: [{ itemType: 'STORE', storeId: 'store-1' }],
      dinerIds: ['diner-2'],
    });
    expect(changed.status).toBe(200);

    const revived = await call<Record<string, unknown>>(
      router,
      'POST',
      `/api/v1/plans/${planId}/complete`,
      { version: (changed.body.data as { version: number }).version },
    );
    expect(revived.status).toBe(200);
    expect(revived.body.data).toMatchObject({ recordCreated: false, recordRevived: true });
    const revivedRecord = revived.body.data!.record as {
      id: string;
      status: string;
      sourceType: string;
      recordDate: string;
      mealType: string;
      items: Array<{ storeId: string | null; recipeId: string | null }>;
      diners: Array<{ id: string }>;
    };
    expect(revivedRecord).toMatchObject({
      id: recordId,
      status: 'DRAFT',
      sourceType: 'DINE_IN',
      recordDate: '2026-11-22',
      mealType: 'DINNER',
    });
    expect(revivedRecord.items).toEqual([
      expect.objectContaining({ storeId: 'store-1', recipeId: null }),
    ]);
    expect(revivedRecord.diners.map((diner) => diner.id)).toEqual(['diner-2']);
    const [revivedRow] = await db.query<{ planUncompleteProof: string | null }>(
      `SELECT "planUncompleteProof" FROM "MealRecord" WHERE "id" = ?`,
      [recordId],
    );
    expect(revivedRow?.planUncompleteProof).toBeNull();

    // 再撤回并改回菜品：同一草稿仍需复活，说明旧快照来源类型不是硬绑定。
    const revertedAgain = await call<Record<string, unknown>>(
      router,
      'POST',
      `/api/v1/plans/${planId}/uncomplete`,
      { version: (revived.body.data!.plan as { version: number }).version },
    );
    expect(revertedAgain.status).toBe(200);
    const backToRecipe = await call<Record<string, unknown>>(
      router,
      'PUT',
      `/api/v1/plans/${planId}`,
      {
        version: (revertedAgain.body.data!.plan as { version: number }).version,
        items: [{ itemType: 'RECIPE', recipeId: 'recipe-1' }],
        dinerIds: ['diner-1', 'diner-2'],
      },
    );
    expect(backToRecipe.status).toBe(200);
    const secondRevive = await call<Record<string, unknown>>(
      router,
      'POST',
      `/api/v1/plans/${planId}/complete`,
      { version: (backToRecipe.body.data as { version: number }).version },
    );
    expect(secondRevive.status).toBe(200);
    expect(secondRevive.body.data!.record).toMatchObject({
      id: recordId,
      sourceType: 'HOMEMADE',
      status: 'DRAFT',
    });
    expect(await db.query('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('T-004b：撤销完成逐项比对日期/餐次/来源/关联计划/items/就餐人，任一变化即 409', async () => {
    const mutations: ReadonlyArray<[string, string]> = [
      ['recordDate', `UPDATE "MealRecord" SET "recordDate" = '2026-11-25' WHERE "id" = ?`],
      ['mealType', `UPDATE "MealRecord" SET "mealType" = 'DINNER' WHERE "id" = ?`],
      ['sourceType', `UPDATE "MealRecord" SET "sourceType" = 'CUSTOM' WHERE "id" = ?`],
      ['relatedPlanId', `UPDATE "MealRecord" SET "relatedPlanId" = NULL WHERE "id" = ?`],
      ['items', `UPDATE "MealRecordItem" SET "recipeId" = 'recipe-2' WHERE "mealRecordId" = ?`],
      [
        'items 顺序',
        `UPDATE "MealRecordItem" SET "sortOrder" = "sortOrder" + 10 WHERE "mealRecordId" = ?`,
      ],
      [
        'dinerIds',
        `UPDATE "MealRecordDiner" SET "dinerId" = 'diner-2' WHERE "mealRecordId" = ? AND "dinerId" = 'diner-1'`,
      ],
    ];

    for (const [label, sql] of mutations) {
      const fresh = await createHarness();
      await seedRecipe(fresh.db);
      await seedRecipe(fresh.db, 'recipe-2', '另一道');
      await seedDiner(fresh.db, 'diner-1', '甲');
      await seedDiner(fresh.db, 'diner-2', '乙');
      const created = await call<Record<string, unknown>>(fresh.router, 'POST', '/api/v1/plans', {
        planDate: TODAY,
        mealType: 'LUNCH',
        dinerCount: 2,
        items: [{ itemType: 'RECIPE', recipeId: 'recipe-1' }],
        dinerIds: ['diner-1'],
      });
      const planId = created.body.data!.id as string;
      const completed = await call<Record<string, unknown>>(
        fresh.router,
        'POST',
        `/api/v1/plans/${planId}/complete`,
        { version: 1 },
      );
      const recordId = (completed.body.data!.record as { id: string }).id as string;

      await fresh.db.withWriteTransaction(async (tx) => {
        await tx.run(sql, [recordId]);
      });
      const before = await outbox(fresh.db);
      const reverted = await call(fresh.router, 'POST', `/api/v1/plans/${planId}/uncomplete`, {
        version: 2,
      });
      expect(reverted.status, label).toBe(409);
      expect(await outbox(fresh.db), label).toEqual(before);
      const [record] = await fresh.db.query<{ deletedAt: string | null; version: number }>(
        `SELECT "deletedAt","version" FROM "MealRecord" WHERE "id" = ?`,
        [recordId],
      );
      expect(record, label).toEqual({ deletedAt: null, version: 1 });
      const [plan] = await fresh.db.query<{ status: string; version: number }>(
        `SELECT "status","version" FROM "MealPlan" WHERE "id" = ?`,
        [planId],
      );
      expect(plan, label).toEqual({ status: 'COMPLETED', version: 2 });
    }
  });

  it('T-004b：自动草稿 PUT 改菜品或就餐人返回 409 且不写库，其它字段仍可改', async () => {
    const { router, db } = harness;
    await seedRecipe(db);
    await seedRecipe(db, 'recipe-2', '另一道');
    await seedDiner(db, 'diner-1', '甲');
    await seedDiner(db, 'diner-2', '乙');

    const created = await call<Record<string, unknown>>(router, 'POST', '/api/v1/plans', {
      planDate: TODAY,
      mealType: 'LUNCH',
      dinerCount: 1,
      items: [{ itemType: 'RECIPE', recipeId: 'recipe-1' }],
      dinerIds: ['diner-1'],
    });
    const planId = created.body.data!.id as string;
    const completed = await call<Record<string, unknown>>(
      router,
      'POST',
      `/api/v1/plans/${planId}/complete`,
      { version: 1 },
    );
    const recordId = (completed.body.data!.record as { id: string }).id as string;
    const before = await outbox(db);

    for (const body of [
      { version: 1, items: [{ itemType: 'RECIPE', recipeId: 'recipe-2' }] },
      { version: 1, dinerIds: ['diner-2'] },
    ]) {
      const result = await call(router, 'PUT', `/api/v1/records/${recordId}`, body);
      expect(result.status, JSON.stringify(body)).toBe(409);
    }
    expect(await outbox(db)).toEqual(before);
    const [record] = await db.query<{ version: number }>(
      `SELECT "version" FROM "MealRecord" WHERE "id" = ?`,
      [recordId],
    );
    expect(record?.version).toBe(1);

    const notes = await call(router, 'PUT', `/api/v1/records/${recordId}`, {
      version: 1,
      notes: '用户备注',
    });
    expect(notes.status).toBe(200);
  });

  it('T-004b：打卡未排序就餐人按 payload 顺序逐行对齐 dinerRowIds，重放可还原', async () => {
    const { router, db } = harness;
    await seedRecipe(db);
    await seedDiner(db, 'diner-1', '甲');
    await seedDiner(db, 'diner-2', '乙');
    await seedDiner(db, 'diner-3', '丙');
    const requested = ['diner-3', 'diner-1', 'diner-2'];

    const cooked = await call<Record<string, unknown>>(
      router,
      'POST',
      '/api/v1/recipes/recipe-1/cook-checkin',
      { recordDate: TODAY, mealType: 'DINNER', dinerIds: requested },
    );
    expect(cooked.status).toBe(201);
    const recordId = (cooked.body.data!.record as { id: string }).id as string;

    const [command] = commandRows(await outbox(db));
    const payload = JSON.parse(command!.payloadJson as string);
    expect(payload.request.dinerIds).toEqual(requested);
    expect(payload.record.dinerRowIds).toHaveLength(requested.length);

    const rows = await db.query<{ id: string; dinerId: string }>(
      `SELECT "id","dinerId" FROM "MealRecordDiner" WHERE "mealRecordId" = ? ORDER BY rowid ASC`,
      [recordId],
    );
    expect(rows.map((row) => row.dinerId)).toEqual(requested);
    expect(payload.record.dinerRowIds).toEqual(rows.map((row) => row.id));
    // 云端只拿到 payload：按 dinerRowIds[i] ↔ dinerIds[i] 逐行对齐即可还原。
    const replay = (payload.record.dinerRowIds as string[]).map(
      (id) => rows.find((row) => row.id === id)?.dinerId,
    );
    expect(replay).toEqual(payload.request.dinerIds);

    const again = await call<Record<string, unknown>>(
      router,
      'POST',
      '/api/v1/recipes/recipe-1/cook-checkin',
      { recordDate: TODAY, mealType: 'DINNER', dinerIds: requested },
    );
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ repeated: true });
    expect(commandRows(await outbox(db))).toHaveLength(1);
  });

  it('T-004b：四个餐饮模块的命令 opId 均为独立随机值，不消耗注入的 newId', async () => {
    const { db } = harness;
    await seedRecipe(db);
    await seedDiner(db, 'diner-1', '甲');

    const consumed: string[] = [];
    const injected = () => {
      const id = `injected-${consumed.length}`;
      consumed.push(id);
      return id;
    };
    const context = { database: db, now: () => NOW, newId: injected };

    const plan = await createPlan(context, {
      planDate: TODAY,
      mealType: 'LUNCH',
      dinerCount: 1,
      status: 'PLANNED',
      notes: null,
      time: null,
      title: null,
      subtext: null,
      icon: null,
      items: [
        {
          itemType: 'RECIPE',
          mealRole: null,
          recipeId: 'recipe-1',
          storeId: null,
          customName: null,
          sortOrder: 0,
        },
      ],
      dinerIds: ['diner-1'],
    });
    const completed = await completePlan(context, plan.id, plan.version);
    const reverted = await uncompletePlan(context, plan.id, completed.plan.version);
    expect(reverted.removedRecord).not.toBeNull();
    const cook = await cookCheckinRecipe(
      db,
      'recipe-1',
      { recordDate: TODAY, mealType: 'DINNER', dinerIds: ['diner-1'] },
      { now: () => NOW, newId: injected },
    );
    await deleteRecord(context, cook.record.id, cook.record.version);

    const commands = commandRows(await outbox(db));
    expect(commands.map((row) => row.commandType)).toEqual([
      'PLAN_COMPLETE',
      'PLAN_UNCOMPLETE',
      'RECIPE_COOK_CHECKIN',
      'RECORD_DELETE',
    ]);
    const opIds = commands.map((row) => row.opId);
    expect(new Set(opIds).size).toBe(opIds.length);
    for (const opId of opIds) {
      expect(opId).toMatch(/^[0-9a-f]{32}$/);
      expect(consumed).not.toContain(opId);
    }
    // 建计划、完成和打卡各使用两个注入的 ID（父行和项目），就餐人行使用派生主键。
    // 撤销、删除及发件箱 opId 都不消耗注入的 ID。
    expect(consumed).toHaveLength(6);
    expect(consumed.every((id) => id.startsWith('injected-'))).toBe(true);
  });

  it('T-004b：POST/PUT 单图 imagePath 必须为 /uploads 且已登记，photos 语义不变', async () => {
    const { router, db } = harness;
    const url = await seedUploadAsset(db, 'main-abc.webp');
    await seedUploadAsset(db, 'main-deleted.webp', { deletedAt: NOW.toISOString() });

    const invalid = [
      { imagePath: '/uploads/unregistered.webp' },
      { imagePath: '/uploads/main-deleted.webp' },
      { imagePath: '../etc/passwd' },
      { imagePath: 'https://example.com/a.webp' },
      { imagePath: 'data:image/webp;base64,AAAA' },
    ];
    for (const body of invalid) {
      const result = await call(router, 'POST', '/api/v1/records', {
        recordDate: TODAY,
        mealType: 'LUNCH',
        sourceType: 'TAKEOUT',
        items: [{ itemType: 'CUSTOM', customName: 'x' }],
        ...body,
      });
      expect(result.status, JSON.stringify(body)).toBe(400);
    }
    expect(await outbox(db)).toEqual([]);

    const created = await call<Record<string, unknown>>(router, 'POST', '/api/v1/records', {
      recordDate: TODAY,
      mealType: 'LUNCH',
      sourceType: 'TAKEOUT',
      imagePath: url,
      items: [{ itemType: 'CUSTOM', customName: '带图' }],
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ imagePath: url, photos: [url] });
    const recordId = created.body.data!.id as string;

    const before = await outbox(db);
    const rejected = await call(router, 'PUT', `/api/v1/records/${recordId}`, {
      version: 1,
      imagePath: '/uploads/unregistered.webp',
    });
    expect(rejected.status).toBe(400);
    expect(await outbox(db)).toEqual(before);

    await seedUploadAsset(db, 'main-def.webp');
    const updated = await call<Record<string, unknown>>(
      router,
      'PUT',
      `/api/v1/records/${recordId}`,
      { version: 1, imagePath: '/uploads/main-def.webp' },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({ imagePath: '/uploads/main-def.webp' });

    // photos 语义保持：显式 photos 覆盖 imagePath，空数组清空两者。
    await seedUploadAsset(db, 'main-ghi.webp');
    const withPhotos = await call<Record<string, unknown>>(
      router,
      'PUT',
      `/api/v1/records/${recordId}`,
      { version: 2, photos: ['/uploads/main-ghi.webp'] },
    );
    expect(withPhotos.body.data).toMatchObject({
      imagePath: '/uploads/main-ghi.webp',
      photos: ['/uploads/main-ghi.webp'],
    });
    const cleared = await call<Record<string, unknown>>(
      router,
      'PUT',
      `/api/v1/records/${recordId}`,
      { version: 3, photos: [] },
    );
    expect(cleared.body.data).toMatchObject({ imagePath: null, photos: null });
  });
});
