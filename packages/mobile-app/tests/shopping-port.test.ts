import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';

import { RETAINED_ENDPOINTS } from '@dafan/shared/contracts';
import type { ShoppingCheckinCommandPayload, ShoppingListUpsertPayload } from '@dafan/shared/sync';

import { openDatabase, type DatabaseHandle } from '../src/db/database.js';
import { SYNC_OUTBOX_TABLE } from '../src/db/schema.js';
import { createLocalApiRouter, type LocalApiRouter } from '../src/local-api/index.js';
import {
  DEFAULT_SHOPPING_LIST_ID,
  registerShopping,
  type ShoppingServiceContext,
  addShoppingItem,
  checkInShoppingItems,
  createShoppingList,
  listShoppingLists,
  replenishRecipe,
  updateShoppingItem,
} from '../src/modules/shopping/index.js';
import { createNodeSqliteDriver } from './helpers/node-sqlite-driver.js';

const ORIGIN = 'http://localhost';
const NOW = new Date('2026-11-21T08:00:00.000Z');
const T0 = NOW.toISOString();

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
  registerShopping(router, async () => db);
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

async function count(db: DatabaseHandle, table: string): Promise<number> {
  const rows = await db.query<{ total: number }>(`SELECT COUNT(*) AS total FROM "${table}"`);
  return rows[0]?.total ?? 0;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface SeedItem {
  readonly id: string;
  readonly name: string;
  readonly quantity: number | null;
  readonly unit: string | null;
  readonly amountText?: string | null;
  readonly sourceType?: string;
  readonly sourceId?: string | null;
  readonly completed?: boolean;
  readonly sortOrder?: number;
}

interface SeedList {
  readonly id: string;
  readonly version?: number;
  readonly name?: string;
  readonly status?: string;
}

/** 直接落库的预置清单（不写发件箱），用于重放场景的同一初始状态。 */
async function seedList(db: DatabaseHandle, list: SeedList, items: readonly SeedItem[] = []) {
  await db.withWriteTransaction(async (tx) => {
    await tx.run(
      `INSERT INTO "ShoppingList" ("id","name","status","notes","version","deletedAt","createdAt","updatedAt")
       VALUES (?, ?, ?, NULL, ?, NULL, ?, ?)`,
      [list.id, list.name ?? '购物清单', list.status ?? 'ACTIVE', list.version ?? 1, T0, T0],
    );
    for (const [index, item] of items.entries()) {
      await tx.run(
        `INSERT INTO "ShoppingListItem"
          ("id","shoppingListId","ingredientId","ingredientNameSnapshot","quantity","unit","amountText",
           "category","sourceType","sourceId","completed","sortOrder","notes","createdAt","updatedAt")
         VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?)`,
        [
          item.id,
          list.id,
          item.name,
          item.quantity,
          item.unit,
          item.amountText ?? null,
          item.sourceType ?? 'MANUAL',
          item.sourceId ?? null,
          item.completed ? 1 : 0,
          item.sortOrder ?? index,
          T0,
          T0,
        ],
      );
    }
  });
}

async function snapshot(db: DatabaseHandle, tables: readonly string[]) {
  const entries: Record<string, unknown[]> = {};
  for (const table of tables) {
    entries[table] = await db.query(`SELECT * FROM "${table}" ORDER BY "id"`);
  }
  return entries;
}

const FACT_TABLES = [
  'ShoppingList',
  'ShoppingListItem',
  'ShoppingCheckinOperation',
  'Ingredient',
  'InventoryBatch',
  'InventoryLog',
] as const;

describe('shopping 9 条保留端点注册', () => {
  it('RETAINED_ENDPOINTS 中 domain=shopping 的 9 条全部已注册且不再 501', async () => {
    const { router } = await createHarness();
    const endpoints = RETAINED_ENDPOINTS.filter((endpoint) => endpoint.domain === 'shopping');
    expect(endpoints).toHaveLength(9);
    for (const endpoint of endpoints) {
      expect(router.has(endpoint.method, endpoint.path), endpoint.path).toBe(true);
    }
    // 只抽样一条真实调用，确认不是占位实现。
    const list = await call(router, 'GET', '/api/v1/shopping-lists?status=ACTIVE');
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.data)).toBe(true);
  });
});

describe('默认活跃清单', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness();
  });

  it('空库首次读取补建固定 ID 空清单，且零发件箱', async () => {
    const { db, router } = harness;
    const first = await call<Array<Record<string, unknown>>>(
      router,
      'GET',
      '/api/v1/shopping-lists?status=ACTIVE',
    );
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(1);
    expect(first.body.data![0]).toMatchObject({
      id: DEFAULT_SHOPPING_LIST_ID,
      status: 'ACTIVE',
      version: 1,
      items: [],
    });
    expect(await outbox(db)).toHaveLength(0);

    // 重复读取只应命中同一行，不重复建表也不写发件箱。
    await call(router, 'GET', '/api/v1/shopping-lists?status=ACTIVE');
    expect(await count(db, 'ShoppingList')).toBe(1);
    expect(await outbox(db)).toHaveLength(0);
  });

  it('现存真实清单优先复用，不补建默认清单也不写发件箱', async () => {
    const { db, router } = harness;
    await seedList(db, { id: 'list-real-family', name: '本周采购' }, [
      { id: 'item-real-1', name: '番茄', quantity: 500, unit: 'GRAM' },
    ]);
    const result = await call<Array<Record<string, unknown>>>(
      router,
      'GET',
      '/api/v1/shopping-lists?status=ACTIVE',
    );
    expect(result.body.data).toHaveLength(1);
    expect(result.body.data![0]).toMatchObject({
      id: 'list-real-family',
      name: '本周采购',
      version: 1,
    });
    expect(await count(db, 'ShoppingList')).toBe(1);
    expect(await outbox(db)).toHaveLength(0);
  });
});

describe('条目 CRUD 与清单版本', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness();
  });

  it('新增条目推进版本并写出含条目事实的清单 upsert', async () => {
    const { db, router } = harness;
    await seedList(db, { id: 'list-crud' });
    const added = await call<Record<string, unknown>>(
      router,
      'POST',
      '/api/v1/shopping-lists/list-crud/items',
      {
        version: 1,
        ingredientName: ' 牛腩 ',
        quantity: 800,
        unit: 'GRAM',
      },
    );
    expect(added.status).toBe(200);
    const list = added.body.data as {
      version: number;
      items: Array<Record<string, unknown>>;
    };
    expect(list.version).toBe(2);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      ingredientName: '牛腩',
      quantity: 800,
      unit: 'GRAM',
      sourceType: 'MANUAL',
      completed: false,
    });

    const rows = await outbox(db);
    expect(rows).toHaveLength(1);
    // 该清单从未同步过：本次即为云端新建，baseVersion 必须为 null。
    expect(rows[0]).toMatchObject({
      entity: 'ShoppingList',
      entityId: 'list-crud',
      kind: 'upsert',
      baseVersion: null,
    });
    const payload = JSON.parse(rows[0]!.payloadJson as string) as ShoppingListUpsertPayload;
    expect(payload.version).toBe(2);
    expect(payload.items.map((item) => item.id)).toEqual([list.items[0]!.id]);
    expect(rows[0]!.payloadHash).toBe(sha256(rows[0]!.payloadJson as string));
  });

  it('版本过期返回 409 VERSION_CONFLICT 且零写入', async () => {
    const { db, router } = harness;
    await seedList(db, { id: 'list-stale', version: 4 });
    const stale = await call(router, 'POST', '/api/v1/shopping-lists/list-stale/items', {
      version: 1,
      ingredientName: '土豆',
      quantity: 3,
      unit: 'PIECE',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error!.code).toBe('VERSION_CONFLICT');
    expect(await count(db, 'ShoppingListItem')).toBe(0);
    expect(await outbox(db)).toHaveLength(0);
  });

  it('数量与单位必须成对提供', async () => {
    const { router } = harness;
    await seedList(harness.db, { id: 'list-pair' });
    const result = await call(router, 'POST', '/api/v1/shopping-lists/list-pair/items', {
      version: 1,
      ingredientName: '葱',
      quantity: 2,
    });
    expect(result.status).toBe(422);
    expect(result.body.error!.code).toBe('SHOPPING_ITEM_INVALID');
  });

  it('勾选更新只改显式字段，写回结构化数量时清空过期自由规格原文', async () => {
    const { db, router } = harness;
    await seedList(db, { id: 'list-update' }, [
      { id: 'item-update', name: '排骨', quantity: 500, unit: 'GRAM', amountText: '约一斤' },
    ]);
    const completed = await call<{ version: number; items: Array<Record<string, unknown>> }>(
      router,
      'PUT',
      '/api/v1/shopping-list-items/item-update',
      { version: 1, completed: true },
    );
    expect(completed.status).toBe(200);
    expect(completed.body.data!.version).toBe(2);
    expect(completed.body.data!.items[0]).toMatchObject({ completed: true, amountText: '约一斤' });

    const restructured = await call<{ version: number; items: Array<Record<string, unknown>> }>(
      router,
      'PUT',
      '/api/v1/shopping-list-items/item-update',
      { version: 2, quantity: 600, unit: 'GRAM' },
    );
    expect(restructured.status).toBe(200);
    expect(restructured.body.data!.items[0]).toMatchObject({
      quantity: 600,
      unit: 'GRAM',
      amountText: null,
    });
    expect(await outbox(db)).toHaveLength(2);
  });

  it('删除条目为行删除并推进版本；已购清理返回 cleared 计数', async () => {
    const { db, router } = harness;
    await seedList(db, { id: 'list-del' }, [
      { id: 'item-a', name: '苹果', quantity: 4, unit: 'PIECE' },
      { id: 'item-b', name: '香蕉', quantity: 6, unit: 'PIECE', completed: true },
    ]);
    const removed = await call(router, 'DELETE', '/api/v1/shopping-list-items/item-a?version=1');
    expect(removed.status).toBe(200);
    expect(await count(db, 'ShoppingListItem')).toBe(1);

    const cleared = await call<{ list: Record<string, unknown>; cleared: number }>(
      router,
      'POST',
      '/api/v1/shopping-lists/list-del/clear-completed',
      { version: 2 },
    );
    expect(cleared.status).toBe(200);
    expect(cleared.body.data).toMatchObject({ cleared: 1 });
    expect(await count(db, 'ShoppingListItem')).toBe(0);
    expect((cleared.body.data!.list as { version: number }).version).toBe(3);

    // 无已购条目时不推进版本，也不写发件箱。
    const before = await outbox(db);
    const noop = await call<{ list: { version: number }; cleared: number }>(
      router,
      'POST',
      '/api/v1/shopping-lists/list-del/clear-completed',
      { version: 3 },
    );
    expect(noop.body.data).toMatchObject({ cleared: 0 });
    expect(noop.body.data!.list.version).toBe(3);
    expect(await outbox(db)).toHaveLength(before.length);
  });
});

describe('replenish-recipe（D5 补缺收敛）', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness();
  });

  it('同菜谱同食材对齐最新差额、跨菜谱与手工项保持独立行、整批一次版本推进', async () => {
    const { db, router } = harness;
    await seedList(db, { id: 'list-replenish' }, [
      { id: 'item-manual', name: '牛奶', quantity: 1, unit: 'LITER', amountText: '手工备忘' },
      {
        id: 'item-other-recipe',
        name: '番茄',
        quantity: 300,
        unit: 'GRAM',
        sourceType: 'RECIPE',
        sourceId: 'recipe-other',
      },
      {
        id: 'item-same-recipe',
        name: '番茄',
        quantity: 200,
        unit: 'GRAM',
        sourceType: 'RECIPE',
        sourceId: 'recipe-main',
      },
    ]);

    const result = await call<{ version: number; items: Array<Record<string, unknown>> }>(
      router,
      'POST',
      '/api/v1/shopping-lists/list-replenish/replenish-recipe',
      {
        version: 1,
        recipeId: 'recipe-main',
        items: [
          { ingredientName: '番茄', quantity: 450, unit: 'GRAM' },
          { ingredientName: '鸡蛋', quantity: 6, unit: 'PIECE' },
        ],
      },
    );
    expect(result.status).toBe(200);
    const list = result.body.data!;
    expect(list.version).toBe(2);
    const byName = list.items.map((item) => [item.ingredientName, item.sourceId, item.quantity]);
    expect(byName).toEqual([
      ['牛奶', null, 1],
      ['番茄', 'recipe-other', 300],
      ['番茄', 'recipe-main', 450],
      ['鸡蛋', 'recipe-main', 6],
    ]);

    const rows = await outbox(db);
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payloadJson as string) as ShoppingListUpsertPayload;
    expect(payload.version).toBe(2);
    expect(payload.items).toHaveLength(4);
    // 新建条目 ID 已固定进载荷，与库里真实行一致。
    const ids = await db.query<{ id: string }>(
      'SELECT "id" FROM "ShoppingListItem" WHERE "shoppingListId" = ? ORDER BY "id"',
      ['list-replenish'],
    );
    expect(payload.items.map((item) => item.id).sort()).toEqual(ids.map((row) => row.id));

    // 再次补同一菜谱同一食材：仍是同一行，数量对齐最新差额。
    const again = await call<{ version: number; items: Array<Record<string, unknown>> }>(
      router,
      'POST',
      '/api/v1/shopping-lists/list-replenish/replenish-recipe',
      {
        version: 2,
        recipeId: 'recipe-main',
        items: [{ ingredientName: '番茄', quantity: 120, unit: 'GRAM' }],
      },
    );
    expect(again.body.data!.version).toBe(3);
    expect(await count(db, 'ShoppingListItem')).toBe(4);
    const sameRecipe = (again.body.data!.items as Array<Record<string, unknown>>).filter(
      (item) => item.sourceId === 'recipe-main' && item.ingredientName === '番茄',
    );
    expect(sameRecipe).toHaveLength(1);
    expect(sameRecipe[0]).toMatchObject({ quantity: 120 });
  });

  it('空 recipeId 返回 422 SHOPPING_RECIPE_REQUIRED', async () => {
    const { router } = harness;
    await seedList(harness.db, { id: 'list-recipe-empty' });
    const result = await call(
      router,
      'POST',
      '/api/v1/shopping-lists/list-recipe-empty/replenish-recipe',
      {
        version: 1,
        recipeId: '   ',
        items: [{ ingredientName: '番茄', quantity: 1, unit: 'PIECE' }],
      },
    );
    expect(result.status).toBe(422);
    expect(result.body.error!.code).toBe('SHOPPING_RECIPE_REQUIRED');
  });
});

describe('check-in（结构化校验 + 幂等入库）', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness();
  });

  it('含自由规格（少许）时整单 422，且零写入', async () => {
    const { db, router } = harness;
    await seedList(db, { id: 'list-rollback' }, [
      { id: 'item-ok', name: '番茄', quantity: 500, unit: 'GRAM' },
      { id: 'item-loose', name: '盐', quantity: null, unit: null, amountText: '少许' },
    ]);
    const result = await call(router, 'POST', '/api/v1/shopping-lists/list-rollback/check-in', {
      version: 1,
      operationId: 'op-rollback-1',
      itemIds: ['item-ok', 'item-loose'],
    });
    expect(result.status).toBe(422);
    expect(result.body.error!.code).toBe('SHOPPING_CHECKIN_QUANTITY_INVALID');
    expect(await count(db, 'Ingredient')).toBe(0);
    expect(await count(db, 'InventoryBatch')).toBe(0);
    expect(await count(db, 'InventoryLog')).toBe(0);
    expect(await count(db, 'ShoppingCheckinOperation')).toBe(0);
    expect(await outbox(db)).toHaveLength(0);
    const [list] = await db.query<{ version: number }>(
      'SELECT "version" FROM "ShoppingList" WHERE "id" = ?',
      ['list-rollback'],
    );
    expect(list!.version).toBe(1);
    const items = await db.query<{ completed: number }>(
      'SELECT "completed" FROM "ShoppingListItem" ORDER BY "id"',
    );
    expect(items.map((row) => row.completed)).toEqual([0, 0]);
  });

  it('OTHER 伪单位同样整单 422 回滚', async () => {
    const { db, router } = harness;
    await seedList(db, { id: 'list-other-unit' }, [
      { id: 'item-other', name: '花椒', quantity: 1, unit: 'OTHER' },
    ]);
    const result = await call(router, 'POST', '/api/v1/shopping-lists/list-other-unit/check-in', {
      version: 1,
      operationId: 'op-other-1',
      itemIds: ['item-other'],
    });
    expect(result.status).toBe(422);
    expect(await count(db, 'Ingredient')).toBe(0);
  });

  it('成功入库：勾选买完 + 新建食材/批次/日志 + operation 幂等行 + 单条 SHOPPING_CHECKIN 命令', async () => {
    const { db, router } = harness;
    await seedList(db, { id: 'list-checkin' }, [
      { id: 'item-tomato', name: '番茄', quantity: 500, unit: 'GRAM' },
      { id: 'item-egg', name: '鸡蛋', quantity: 6, unit: 'PIECE' },
      { id: 'item-keep', name: '大米', quantity: 2, unit: 'KILOGRAM' },
    ]);
    const result = await call<{
      list: { version: number; items: Array<Record<string, unknown>> };
      imported: { operationId: string; itemIds: string[] };
    }>(router, 'POST', '/api/v1/shopping-lists/list-checkin/check-in', {
      version: 1,
      operationId: 'op-checkin-1',
      itemIds: ['item-egg', 'item-tomato'],
    });
    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({
      list: { version: 2 },
      imported: { operationId: 'op-checkin-1', itemIds: ['item-egg', 'item-tomato'] },
    });
    expect(result.body.data!.list.items).toMatchObject([{ id: 'item-keep', completed: false }]);

    expect(await count(db, 'Ingredient')).toBe(2);
    expect(await count(db, 'InventoryBatch')).toBe(2);
    expect(await count(db, 'InventoryLog')).toBe(2);
    expect(await count(db, 'ShoppingCheckinOperation')).toBe(1);

    const rows = await outbox(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entity: 'ShoppingList',
      entityId: 'list-checkin',
      kind: 'command',
      commandType: 'SHOPPING_CHECKIN',
      baseVersion: 1,
    });
    expect(rows[0]!.payloadHash).toBe(sha256(rows[0]!.payloadJson as string));

    const payload = JSON.parse(rows[0]!.payloadJson as string) as ShoppingCheckinCommandPayload;
    expect(payload.executedAt).toBe(T0);
    expect(payload.listVersion).toBe(2);
    expect(payload.request).toEqual({
      shoppingListId: 'list-checkin',
      baseVersion: 1,
      operationId: 'op-checkin-1',
      itemIds: ['item-egg', 'item-tomato'],
    });
    expect(payload.items.map((item) => item.id)).toEqual(['item-egg', 'item-tomato']);
    expect(payload.items.every((item) => !item.completed)).toBe(true);
    expect(payload.inventory).toHaveLength(2);
    for (const fact of payload.inventory) {
      expect(fact).toMatchObject({
        kind: 'INGREDIENT_IMPORT',
        createdIngredient: true,
        executedAt: T0,
      });
      const [ingredient] = await db.query<Record<string, unknown>>(
        'SELECT * FROM "Ingredient" WHERE "id" = ?',
        [fact.ingredientId],
      );
      expect(ingredient).toBeDefined();
      expect(ingredient!.name).toBe(fact.ingredientNameSnapshot);
      const [batch] = await db.query<Record<string, unknown>>(
        'SELECT * FROM "InventoryBatch" WHERE "id" = ?',
        [fact.batchId],
      );
      expect(batch).toMatchObject({
        ingredientId: fact.ingredientId,
        quantity: fact.batchQuantity,
        unit: fact.batchUnit,
        createdAt: T0,
      });
      const [log] = await db.query<Record<string, unknown>>(
        'SELECT * FROM "InventoryLog" WHERE "id" = ?',
        [fact.logId],
      );
      expect(log).toMatchObject({
        inventoryBatchId: fact.batchId,
        changeType: 'PURCHASE',
        createdAt: T0,
      });
    }
    expect(payload.operation).toMatchObject({
      id: 'op-checkin-1',
      shoppingListId: 'list-checkin',
      createdAt: T0,
    });
    expect(payload.operation.payloadHash).toBe(
      sha256(
        JSON.stringify({ shoppingListId: 'list-checkin', itemIds: ['item-egg', 'item-tomato'] }),
      ),
    );
    expect(JSON.parse(payload.operation.resultJson)).toEqual(result.body.data);
  });

  it('同 operationId 同内容幂等重放：返回首次结果、零重复入库、零新增发件箱', async () => {
    const { db, router } = harness;
    await seedList(db, { id: 'list-idempotent' }, [
      { id: 'item-milk', name: '牛奶', quantity: 1, unit: 'LITER' },
    ]);
    const body = { version: 1, operationId: 'op-same', itemIds: ['item-milk'] };
    const first = await call(
      router,
      'POST',
      '/api/v1/shopping-lists/list-idempotent/check-in',
      body,
    );
    expect(first.status).toBe(200);
    const second = await call(
      router,
      'POST',
      '/api/v1/shopping-lists/list-idempotent/check-in',
      body,
    );
    expect(second.status).toBe(200);
    expect(second.body.data).toEqual(first.body.data);
    expect(await count(db, 'Ingredient')).toBe(1);
    expect(await count(db, 'InventoryBatch')).toBe(1);
    expect(await count(db, 'InventoryLog')).toBe(1);
    expect(await count(db, 'ShoppingCheckinOperation')).toBe(1);
    expect(await outbox(db)).toHaveLength(1);
  });

  it('同 operationId 异内容返回 409 IDEMPOTENCY_CONFLICT', async () => {
    const { db, router } = harness;
    await seedList(db, { id: 'list-conflict' }, [
      { id: 'item-a', name: '番茄', quantity: 500, unit: 'GRAM' },
      { id: 'item-b', name: '黄瓜', quantity: 2, unit: 'PIECE' },
    ]);
    await call(router, 'POST', '/api/v1/shopping-lists/list-conflict/check-in', {
      version: 1,
      operationId: 'op-dup',
      itemIds: ['item-a'],
    });
    const conflict = await call(router, 'POST', '/api/v1/shopping-lists/list-conflict/check-in', {
      version: 2,
      operationId: 'op-dup',
      itemIds: ['item-a', 'item-b'],
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error!.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await count(db, 'Ingredient')).toBe(1);
  });

  it('按命令载荷固定 ID 逐行重放，业务表与发件箱载荷逐行一致', async () => {
    const primary = await createHarness();
    const seed = [
      { id: 'item-replay-a', name: '番茄', quantity: 500, unit: 'GRAM', sortOrder: 0 },
      { id: 'item-replay-b', name: '鸡蛋', quantity: 6, unit: 'PIECE', sortOrder: 1 },
    ] as const;
    await seedList(primary.db, { id: 'list-replay' }, seed);
    const body = {
      version: 1,
      operationId: 'op-replay',
      itemIds: ['item-replay-a', 'item-replay-b'],
    };
    const first = await call(
      primary.router,
      'POST',
      '/api/v1/shopping-lists/list-replay/check-in',
      body,
    );
    expect(first.status).toBe(200);

    const command = (await outbox(primary.db))[0]!;
    const payload = JSON.parse(command.payloadJson as string) as ShoppingCheckinCommandPayload;
    const replayIds: string[] = [];
    for (const fact of payload.inventory) {
      if (fact.createdIngredient) replayIds.push(fact.ingredientId);
      replayIds.push(fact.batchId, fact.logId);
    }
    // 最后一条 ID 用于命令自身的 opId。
    replayIds.push('op-id-sink');
    let cursor = 0;
    const fixedIds = () => {
      const id = replayIds[cursor];
      cursor += 1;
      if (!id) throw new Error(`确定性 ID 序列已耗尽（已取 ${cursor - 1} 个）`);
      return id;
    };

    const replayed = await createHarness();
    await seedList(replayed.db, { id: 'list-replay' }, seed);
    const ctx: ShoppingServiceContext = {
      database: replayed.db,
      now: () => NOW,
      newId: fixedIds,
    };
    await checkInShoppingItems(ctx, 'list-replay', {
      version: 1,
      operationId: 'op-replay',
      itemIds: ['item-replay-a', 'item-replay-b'],
    });

    expect(await snapshot(replayed.db, FACT_TABLES)).toEqual(
      await snapshot(primary.db, FACT_TABLES),
    );
    const replayedOutbox = await outbox(replayed.db);
    expect(replayedOutbox).toHaveLength(1);
    expect(replayedOutbox[0]!.payloadJson).toBe(command.payloadJson);
    expect(replayedOutbox[0]!.payloadHash).toBe(command.payloadHash);
    expect(replayedOutbox[0]!.payloadHash).toBe(sha256(replayedOutbox[0]!.payloadJson as string));
    expect(cursor).toBe(replayIds.length);
  });
});

describe('购物清单服务直调（不经路由）', () => {
  it('createShoppingList 返回 201 DTO 语义并写入单条 upsert', async () => {
    const db = await openDatabase({
      driver: createNodeSqliteDriver({ path: ':memory:' }),
      now: () => NOW,
    });
    const ctx: ShoppingServiceContext = { database: db, now: () => NOW };
    const created = await createShoppingList(ctx, { name: '周末采购' });
    expect(created).toMatchObject({ name: '周末采购', status: 'ACTIVE', version: 1, items: [] });
    expect(await outbox(db)).toHaveLength(1);

    const list = await listShoppingLists(ctx, { status: 'ACTIVE' });
    expect(list.map((row) => row.id)).toContain(created.id);

    const added = await addShoppingItem(ctx, created.id, {
      version: 1,
      ingredientName: '豆腐',
      quantity: 2,
      unit: 'BOX',
    });
    const updated = await updateShoppingItem(ctx, added.items[0]!.id, {
      version: added.version,
      completed: true,
    });
    expect(updated.items[0]!.completed).toBe(true);

    const replenished = await replenishRecipe(ctx, created.id, {
      version: updated.version,
      recipeId: 'recipe-direct',
      items: [{ ingredientName: '豆腐', quantity: 1, unit: 'BOX' }],
    });
    expect(replenished.items).toHaveLength(2);
    expect(replenished.items.find((item) => item.sourceId === 'recipe-direct')).toMatchObject({
      ingredientName: '豆腐',
      quantity: 1,
    });
  });
});

describe('check-in 与既有库存数据', () => {
  it('同名既有食材累加入库，不新建重复食材行', async () => {
    const db = await openDatabase({
      driver: createNodeSqliteDriver({ path: ':memory:' }),
      now: () => NOW,
    });
    await seedList(db, { id: 'list-existing' }, [
      { id: 'item-existing', name: '番茄', quantity: 500, unit: 'GRAM' },
    ]);
    // 既有食材：已有活批次 300g。
    await db.withWriteTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO "Ingredient" ("id","name","imagePath","category","quantity","unit","purchaseDate","expiryDate","location","minStock","maxStock","opened","notes","version","deletedAt","createdAt","updatedAt")
         VALUES ('ing-tomato','番茄',NULL,'蔬菜',300,'GRAM',NULL,NULL,NULL,NULL,NULL,0,NULL,1,NULL,?,?)`,
        [T0, T0],
      );
      await tx.run(
        `INSERT INTO "InventoryBatch" ("id","ingredientId","quantity","unit","purchaseDate","expiryDate","location","opened","consumePriority","notes","version","deletedAt","createdAt","updatedAt")
         VALUES ('batch-old','ing-tomato',300,'GRAM',NULL,NULL,NULL,0,0,NULL,1,NULL,?,?)`,
        [T0, T0],
      );
    });

    const ctx: ShoppingServiceContext = { database: db, now: () => NOW };
    const result = await checkInShoppingItems(ctx, 'list-existing', {
      version: 1,
      operationId: 'op-existing',
      itemIds: ['item-existing'],
    });
    expect(await count(db, 'Ingredient')).toBe(1);
    const [ingredient] = await db.query<{ quantity: number; version: number }>(
      'SELECT "quantity","version" FROM "Ingredient" WHERE "id" = ?',
      ['ing-tomato'],
    );
    expect(ingredient).toMatchObject({ quantity: 800, version: 2 });
    expect(await count(db, 'InventoryBatch')).toBe(2);
    expect(result.imported.inventory).toHaveLength(1);
    expect(result.imported.inventory[0]).toMatchObject({
      kind: 'INGREDIENT_IMPORT',
      createdIngredient: false,
      ingredientId: 'ing-tomato',
      ingredientQuantity: 800,
      ingredientVersion: 2,
      batchQuantity: 500,
    });
    const command = (await outbox(db))[0]!;
    const payload = JSON.parse(command.payloadJson as string) as ShoppingCheckinCommandPayload;
    const [batchId, logId] = [
      result.imported.inventory[0]!.batchId,
      result.imported.inventory[0]!.logId,
    ];
    const [batch] = await db.query<{ ingredientId: string }>(
      'SELECT "ingredientId" FROM "InventoryBatch" WHERE "id" = ?',
      [batchId],
    );
    expect(batch!.ingredientId).toBe('ing-tomato');
    expect(payload.inventory[0]!.logId).toBe(logId);
  });

  it('历史存量（无活批次）入库前补建等效批次，LEGACY_HEAL 事实随命令固化', async () => {
    const db = await openDatabase({
      driver: createNodeSqliteDriver({ path: ':memory:' }),
      now: () => NOW,
    });
    await seedList(db, { id: 'list-legacy' }, [
      { id: 'item-legacy', name: '大米', quantity: 1, unit: 'KILOGRAM' },
    ]);
    await db.withWriteTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO "Ingredient" ("id","name","imagePath","category","quantity","unit","purchaseDate","expiryDate","location","minStock","maxStock","opened","notes","version","deletedAt","createdAt","updatedAt")
         VALUES ('ing-rice','大米',NULL,'主食粮油',2,'KILOGRAM',NULL,NULL,NULL,NULL,NULL,0,NULL,1,NULL,?,?)`,
        [T0, T0],
      );
    });
    const ctx: ShoppingServiceContext = { database: db, now: () => NOW };
    const result = await checkInShoppingItems(ctx, 'list-legacy', {
      version: 1,
      operationId: 'op-legacy',
      itemIds: ['item-legacy'],
    });
    expect(result.imported.inventory.map((fact) => fact.kind)).toEqual([
      'LEGACY_HEAL',
      'INGREDIENT_IMPORT',
    ]);
    const [ingredient] = await db.query<{ quantity: number; version: number }>(
      'SELECT "quantity","version" FROM "Ingredient" WHERE "id" = ?',
      ['ing-rice'],
    );
    expect(ingredient).toMatchObject({ quantity: 3, version: 2 });
    const command = (await outbox(db))[0]!;
    const payload = JSON.parse(command.payloadJson as string) as ShoppingCheckinCommandPayload;
    expect(payload.inventory[0]).toMatchObject({ kind: 'LEGACY_HEAL', afterQuantity: 2 });
    expect(payload.inventory[1]).toMatchObject({ kind: 'INGREDIENT_IMPORT', batchQuantity: 1 });
  });
});
