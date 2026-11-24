import { describe, expect, it } from 'vitest';

import { RETAINED_MODELS } from '@dafan/shared/contracts';
import {
  SYNC_COMMAND_ENTITIES,
  type SyncEntityName,
  type SyncOperation,
  type SyncPayload,
} from '@dafan/shared/sync';

import type { DatabaseHandle } from '../../mobile-app/src/db/database.js';
import {
  consumeIngredient,
  createIngredient,
  updateIngredient,
} from '../../mobile-app/src/modules/ingredients/service.js';
import {
  completePlan,
  createPlan,
  uncompletePlan,
} from '../../mobile-app/src/modules/meal-plans/service.js';
import { deleteRecord } from '../../mobile-app/src/modules/meal-records/service.js';
import { createRecipe } from '../../mobile-app/src/modules/recipes/service.js';
import { cookCheckinRecipe } from '../../mobile-app/src/modules/recipes/cook-checkin.js';
import {
  addShoppingItem,
  checkInShoppingItems,
  listShoppingLists,
  type ShoppingServiceContext,
} from '../../mobile-app/src/modules/shopping/service.js';
import { createTool } from '../../mobile-app/src/modules/tools/service.js';
import { REPLAY_ORDER, REPLAY_TABLES } from '../src/sync-replay-tables';
import {
  clearReplayHistory,
  replayOperation,
  ReplayConflict,
  ReplayValidationError,
} from '../src/sync-replay';
import { ledger, mobile, outbox, toOperation, type Ledger } from './sync-replay-helpers';

const COLUMNS: Partial<Record<SyncEntityName, readonly string[]>> = {
  Ingredient: ['id', 'name', 'category', 'quantity', 'unit', 'version', 'createdAt', 'updatedAt'],
  InventoryBatch: [
    'id',
    'ingredientId',
    'quantity',
    'unit',
    'purchaseDate',
    'expiryDate',
    'opened',
    'consumePriority',
    'version',
    'deletedAt',
    'createdAt',
    'updatedAt',
  ],
  InventoryLog: [
    'id',
    'ingredientId',
    'inventoryBatchId',
    'beforeQuantity',
    'changeQuantity',
    'afterQuantity',
    'changeType',
    'createdAt',
    'updatedAt',
  ],
  MealPlan: [
    'id',
    'planDate',
    'mealType',
    'status',
    'dinerCount',
    'version',
    'completedAt',
    'deletedAt',
  ],
  MealPlanItem: ['id', 'mealPlanId', 'itemType', 'customName', 'sortOrder'],
  MealPlanDiner: ['id', 'mealPlanId', 'dinerId'],
  MealRecord: [
    'id',
    'recordDate',
    'recordTime',
    'mealType',
    'sourceType',
    'status',
    'title',
    'photosJson',
    'version',
    'deletedAt',
    'planUncompleteProof',
  ],
  MealRecordItem: ['id', 'mealRecordId', 'itemType', 'recipeId', 'customName', 'sortOrder'],
  MealRecordDiner: ['id', 'mealRecordId', 'dinerId'],
  Recipe: ['id', 'name', 'version'],
  RecipeIngredient: ['id', 'recipeId', 'ingredientNameSnapshot', 'sortOrder'],
  RecipeStep: ['id', 'recipeId', 'stepNo', 'content'],
  RecipeTag: ['id', 'recipeId', 'tagId'],
  Tag: ['id', 'name', 'type', 'deletedAt'],
  KitchenTool: ['id', 'name', 'quantity', 'version'],
  ShoppingList: ['id', 'name', 'status', 'version'],
  ShoppingListItem: [
    'id',
    'shoppingListId',
    'ingredientNameSnapshot',
    'quantity',
    'completed',
    'sortOrder',
  ],
  ShoppingCheckinOperation: ['id', 'shoppingListId', 'payloadHash', 'resultJson'],
};

function columnsOf(table: SyncEntityName): readonly string[] {
  return COLUMNS[table] ?? REPLAY_TABLES[table].columns;
}

async function mobileRows(db: DatabaseHandle, table: SyncEntityName, columns: readonly string[]) {
  return db.query<Record<string, unknown>>(
    `SELECT ${columns.map((column) => `"${column}"`).join(', ')} FROM "${table}" ORDER BY "id"`,
  );
}

function ledgerRows(target: Ledger, table: SyncEntityName, columns: readonly string[]) {
  return target.sql
    .exec(
      `SELECT ${columns.map((column) => `"${column}"`).join(', ')} FROM "${table}" ORDER BY "id"`,
    )
    .toArray() as unknown as Record<string, unknown>[];
}

async function compare(
  target: Ledger,
  db: DatabaseHandle,
  tables: readonly SyncEntityName[],
): Promise<void> {
  for (const table of tables) {
    const columns = columnsOf(table);
    expect(ledgerRows(target, table, columns), table).toEqual(await mobileRows(db, table, columns));
  }
}

/** 只重放尚未处理的 outbox 行（模拟运输层 ack 后的增量推送）。 */
class Replayer {
  readonly #seen = new Set<string>();
  readonly #target: Ledger;

  constructor(target: Ledger) {
    this.#target = target;
  }

  /** 取出未处理操作但不在云端重放（供端侧复现测试）。 */
  async drain(db: DatabaseHandle): Promise<SyncOperation[]> {
    const rows = await outbox(db);
    const fresh = rows.filter((row) => !this.#seen.has(row.opId));
    const operations = fresh.map(toOperation);
    for (const operation of operations) this.#seen.add(operation.id);
    return operations;
  }

  async sync(db: DatabaseHandle): Promise<SyncOperation[]> {
    const operations = await this.drain(db);
    for (const operation of operations) replayOperation(this.#target.sql, operation);
    return operations;
  }
}

function count(target: Ledger, table: string): number {
  return target.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM "${table}"`).one().count;
}

function payload(value: Record<string, unknown>): SyncPayload {
  return value as unknown as SyncPayload;
}

function randomId(): () => string {
  return () => crypto.randomUUID().replaceAll('-', '');
}

describe('27 表与命令注册', () => {
  it('覆盖 shared 的全部业务表，列清单与真实 schema 一致', () => {
    expect(Object.keys(REPLAY_TABLES).sort()).toEqual([...RETAINED_MODELS].sort());
    expect([...REPLAY_ORDER].sort()).toEqual([...RETAINED_MODELS].sort());
    expect(Object.keys(SYNC_COMMAND_ENTITIES).sort()).toEqual(
      [
        'INGREDIENT_CONSUME',
        'INGREDIENT_UPDATE_SYNC_BATCHES',
        'PLAN_COMPLETE',
        'PLAN_UNCOMPLETE',
        'RECORD_DELETE',
        'RECIPE_COOK_CHECKIN',
        'SHOPPING_CHECKIN',
      ].sort(),
    );

    const target = ledger();
    try {
      for (const table of RETAINED_MODELS) {
        const actual = target.sql
          .exec<{ name: string }>(`PRAGMA table_info("${table}")`)
          .toArray()
          .map(({ name }) => name);
        expect(actual, table).toEqual([...REPLAY_TABLES[table].columns]);
      }
    } finally {
      target.close();
    }
  });

  it('无 version 列的表忽略载荷里多余的 version，按自然键对齐', () => {
    const target = ledger();
    try {
      const payload = {
        id: 'tag-1',
        name: '快手菜',
        type: 'GENERAL',
        deletedAt: null,
        version: 7,
        createdAt: '2026-11-21T08:00:00.000Z',
        updatedAt: '2026-11-21T08:00:00.000Z',
      };
      const result = replayOperation(target.sql, {
        id: 'op-tag',
        entity: 'Tag',
        entityId: 'tag-1',
        kind: 'upsert',
        baseVersion: null,
        payload,
      });
      expect(result.newVersion).toBe(1);
      const change = result.changes.find((entry) => entry.table === 'Tag');
      expect(Object.keys(change?.row ?? {})).not.toContain('version');

      replayOperation(target.sql, {
        id: 'op-tag-2',
        entity: 'Tag',
        entityId: 'tag-1',
        kind: 'upsert',
        baseVersion: null,
        payload: { ...payload, version: 9, updatedAt: '2026-11-21T09:00:00.000Z' },
      });
      expect(count(target, 'Tag')).toBe(1);
    } finally {
      target.close();
    }
  });

  it('外键缺失抛校验错误且不落行', () => {
    const target = ledger();
    try {
      expect(() =>
        replayOperation(target.sql, {
          id: 'op-item',
          entity: 'ShoppingListItem',
          entityId: 'item-1',
          kind: 'upsert',
          baseVersion: null,
          payload: {
            id: 'item-1',
            shoppingListId: 'missing-list',
            ingredientNameSnapshot: '鸡蛋',
            sourceType: 'MANUAL',
            completed: false,
            sortOrder: 0,
            createdAt: '2026-11-21T08:00:00.000Z',
            updatedAt: '2026-11-21T08:00:00.000Z',
          },
        }),
      ).toThrow(ReplayValidationError);
      expect(count(target, 'ShoppingListItem')).toBe(0);
    } finally {
      target.close();
    }
  });

  it('KitchenTool 端侧 upsert 可重放并保持版本链', async () => {
    const db = await mobile();
    const target = ledger();
    try {
      const replayer = new Replayer(target);
      await createTool(db, { name: '炒锅', quantity: 2 }, new Date('2026-11-21T08:00:00Z'));
      await replayer.sync(db);
      await compare(target, db, ['KitchenTool']);
      expect(ledgerRows(target, 'KitchenTool', ['version'])).toEqual([{ version: 1 }]);
    } finally {
      await db.close();
      target.close();
    }
  });
});

describe('食材命令', () => {
  it('创建 upsert：复用批次/日志 ID，父行先于子表出现在 changes', async () => {
    const db = await mobile();
    const target = ledger();
    try {
      const replayer = new Replayer(target);
      await createIngredient(
        { database: db, now: () => new Date('2026-11-21T08:00:00Z') },
        {
          name: '鸡蛋',
          unit: 'PIECE',
          category: '蛋奶豆制',
          batches: [
            { quantity: 2, unit: 'PIECE', expiryDate: '2026-12-01' },
            { quantity: 1, unit: 'PIECE', opened: true },
          ],
        },
      );
      const [operation] = await replayer.sync(db);
      expect(operation?.kind).toBe('upsert');
      await compare(target, db, ['Ingredient', 'InventoryBatch', 'InventoryLog']);

      const result = replayOperation(target.sql, operation!);
      const order = result.changes.map((change) => change.table);
      expect(order.indexOf('Ingredient')).toBeLessThan(order.indexOf('InventoryBatch'));
      expect(order.indexOf('InventoryBatch')).toBeLessThan(order.indexOf('InventoryLog'));
      for (const change of result.changes) expect(change.row).not.toBeNull();
    } finally {
      await db.close();
      target.close();
    }
  });

  it('INGREDIENT_CONSUME 重放逐行一致；后到超扣返回 INSUFFICIENT_STOCK 且零落库', async () => {
    const db = await mobile();
    const target = ledger();
    try {
      const replayer = new Replayer(target);
      const now = () => new Date('2026-11-21T08:00:00Z');
      const ingredient = await createIngredient(
        { database: db, now },
        { name: '鸡蛋', unit: 'PIECE', batches: [{ quantity: 3, unit: 'PIECE' }] },
      );
      await consumeIngredient({ database: db, now }, ingredient.id, {
        mode: 'QUANTITY',
        quantity: 2,
        unit: 'PIECE',
        ingredientVersion: 1,
      });
      await replayer.sync(db);
      await compare(target, db, ['Ingredient', 'InventoryBatch', 'InventoryLog']);

      const consumeRow = (await outbox(db)).find(
        (row) => row.commandType === 'INGREDIENT_CONSUME',
      )!;
      const payload = JSON.parse(consumeRow.payloadJson as string) as Record<string, unknown>;
      const before = ledgerRows(target, 'Ingredient', REPLAY_TABLES.Ingredient.columns);
      const logsBefore = count(target, 'InventoryLog');

      // 第二台设备离线只看到 3 个，同样扣 2；云端只剩 1 → 整单拒绝。
      let rejection: ReplayConflict | undefined;
      try {
        replayOperation(target.sql, {
          id: 'op-consume-b',
          entity: 'Ingredient',
          entityId: ingredient.id,
          kind: 'command',
          commandType: 'INGREDIENT_CONSUME',
          baseVersion: 2,
          payload: {
            ...payload,
            baseVersion: 2,
            request: { ...(payload.request as Record<string, unknown>), ingredientVersion: 2 },
          },
          payloadHash: 'a'.repeat(64),
        });
      } catch (error) {
        rejection = error as ReplayConflict;
      }
      expect(rejection).toBeInstanceOf(ReplayConflict);
      expect(rejection?.rejection).toMatchObject({
        code: 'INSUFFICIENT_STOCK',
        ingredientId: ingredient.id,
      });
      expect(rejection?.rejection.winner).toMatchObject({ id: ingredient.id, quantity: 1 });
      expect(ledgerRows(target, 'Ingredient', REPLAY_TABLES.Ingredient.columns)).toEqual(before);
      expect(count(target, 'InventoryLog')).toBe(logsBefore);
    } finally {
      await db.close();
      target.close();
    }
  });

  it('INGREDIENT_UPDATE_SYNC_BATCHES：替换批次复用命令 ID，逐行一致', async () => {
    const db = await mobile();
    const target = ledger();
    try {
      const replayer = new Replayer(target);
      const now = () => new Date('2026-11-21T08:00:00Z');
      const ingredient = await createIngredient(
        { database: db, now },
        { name: '面粉', unit: 'KILOGRAM', batches: [{ quantity: 1, unit: 'KILOGRAM' }] },
      );
      await updateIngredient({ database: db, now }, ingredient.id, 1, {
        name: '面粉',
        unit: 'KILOGRAM',
        batches: [
          { quantity: 250, unit: 'GRAM', opened: true },
          { quantity: 2, unit: 'KILOGRAM' },
        ],
      });
      await replayer.sync(db);
      await compare(target, db, ['Ingredient', 'InventoryBatch', 'InventoryLog']);
      expect(count(target, 'InventoryLog')).toBe(3);
    } finally {
      await db.close();
      target.close();
    }
  });

  it('INGREDIENT_UPDATE_SYNC_BATCHES：addedBatch 与 deductions 均按命令 ID 重放', async () => {
    const db = await mobile();
    const target = ledger();
    try {
      const replayer = new Replayer(target);
      const now = () => new Date('2026-11-21T08:00:00Z');
      const ingredient = await createIngredient(
        { database: db, now },
        {
          name: '牛奶',
          unit: 'MILLILITER',
          batches: [
            { quantity: 200, unit: 'MILLILITER', expiryDate: '2026-12-31' },
            { quantity: 300, unit: 'MILLILITER', expiryDate: '2026-12-01', consumePriority: true },
          ],
        },
      );
      await updateIngredient({ database: db, now }, ingredient.id, 1, {
        name: '牛奶',
        unit: 'MILLILITER',
        quantity: 700,
      });
      await updateIngredient({ database: db, now }, ingredient.id, 2, {
        name: '牛奶',
        unit: 'MILLILITER',
        quantity: 250,
      });
      await replayer.sync(db);
      await compare(target, db, ['Ingredient', 'InventoryBatch', 'InventoryLog']);
    } finally {
      await db.close();
      target.close();
    }
  });
});

describe('排餐 / 记录命令', () => {
  async function plannedMeal(db: DatabaseHandle, date: string, mealType: 'LUNCH' | 'DINNER') {
    const now = () => new Date('2026-11-21T08:00:00Z');
    return createPlan(
      { database: db, now, newId: randomId() },
      {
        planDate: date,
        mealType,
        dinerCount: 1,
        status: 'PLANNED',
        notes: null,
        time: null,
        title: null,
        subtext: null,
        icon: null,
        items: [
          {
            itemType: 'CUSTOM',
            mealRole: 'MAIN',
            recipeId: null,
            storeId: null,
            customName: '番茄炒蛋',
            sortOrder: 0,
          },
        ],
        dinerIds: [],
      },
    );
  }

  it('PLAN_COMPLETE 重放：计划与自动记录逐列一致', async () => {
    const db = await mobile();
    const target = ledger();
    try {
      const replayer = new Replayer(target);
      const now = () => new Date('2026-11-21T08:00:00Z');
      const plan = await plannedMeal(db, '2026-11-21', 'DINNER');
      await completePlan({ database: db, now, newId: randomId() }, plan.id, 1);
      const ops = await replayer.sync(db);
      expect(
        ops.map((operation) =>
          operation.kind === 'command' ? operation.commandType : operation.kind,
        ),
      ).toEqual(['upsert', 'PLAN_COMPLETE']);
      await compare(target, db, ['MealPlan', 'MealPlanItem', 'MealRecord', 'MealRecordItem']);
      expect(ledgerRows(target, 'MealPlan', ['status'])).toEqual([{ status: 'COMPLETED' }]);
    } finally {
      await db.close();
      target.close();
    }
  });

  it('PLAN_UNCOMPLETE 重放：记录软删并写入 provenance', async () => {
    const db = await mobile();
    const target = ledger();
    try {
      const replayer = new Replayer(target);
      const now = () => new Date('2026-11-21T08:00:00Z');
      const plan = await plannedMeal(db, '2026-11-22', 'LUNCH');
      const completed = await completePlan({ database: db, now, newId: randomId() }, plan.id, 1);
      const result = await uncompletePlan({ database: db, now, newId: randomId() }, plan.id, 2);
      expect(result.plan.status).toBe('PLANNED');
      await replayer.sync(db);
      await compare(target, db, ['MealPlan', 'MealPlanItem', 'MealRecord', 'MealRecordItem']);

      const proof = target.sql
        .exec<{ planUncompleteProof: string | null; deletedAt: string | null }>(
          'SELECT "planUncompleteProof","deletedAt" FROM "MealRecord" WHERE "id" = ?',
          completed.record.id,
        )
        .one();
      expect(proof.planUncompleteProof).toContain('PLAN_UNCOMPLETE');
      expect(proof.deletedAt).not.toBeNull();
    } finally {
      await db.close();
      target.close();
    }
  });

  it('RECORD_DELETE 重放：记录软删、关联计划回退为 PLANNED', async () => {
    const db = await mobile();
    const target = ledger();
    try {
      const replayer = new Replayer(target);
      const now = () => new Date('2026-11-21T08:00:00Z');
      const plan = await plannedMeal(db, '2026-11-24', 'DINNER');
      const completed = await completePlan({ database: db, now, newId: randomId() }, plan.id, 1);
      await deleteRecord(
        { database: db, now, newId: randomId() },
        completed.record.id,
        completed.record.version,
      );
      await replayer.sync(db);
      await compare(target, db, ['MealPlan', 'MealRecord']);
      expect(ledgerRows(target, 'MealPlan', ['status'])).toEqual([{ status: 'PLANNED' }]);
      const record = target.sql
        .exec<{ deletedAt: string | null; sourceMealPlanId: string | null }>(
          'SELECT "deletedAt","sourceMealPlanId" FROM "MealRecord" WHERE "id" = ?',
          completed.record.id,
        )
        .one();
      expect(record.deletedAt).not.toBeNull();
      expect(record.sourceMealPlanId).toBeNull();
    } finally {
      await db.close();
      target.close();
    }
  });

  it('RECIPE_COOK_CHECKIN：复用记录/条目 ID 且不写库存日志', async () => {
    const db = await mobile();
    const target = ledger();
    try {
      const replayer = new Replayer(target);
      const now = () => new Date('2026-11-21T08:00:00Z');
      const recipe = await createRecipe(
        { database: db, now, newId: randomId() },
        {
          name: '番茄炒蛋',
          category: '家常',
          imagePath: null,
          ingredientsText: null,
          cookingTimeMinutes: 10,
          difficulty: null,
          spicyLevel: null,
          servings: 2,
          calories: 320,
          sourceNote: null,
          notes: null,
          favorite: false,
          enabledForRecommendation: true,
          ingredients: [],
          steps: [{ content: '炒', title: null, timerMinutes: null, imagePath: null }],
          tools: [],
          tags: ['快手菜'],
          mealTypes: ['DINNER'],
          mealRoles: [],
        },
      );
      await replayer.sync(db);
      await compare(target, db, ['Recipe', 'RecipeStep', 'RecipeTag', 'Tag']);

      const checkin = await cookCheckinRecipe(
        db,
        recipe.id,
        { recordDate: '2026-11-21', mealType: 'DINNER' },
        { now, newId: randomId() },
      );
      await replayer.sync(db);
      await compare(target, db, ['MealRecord', 'MealRecordItem']);

      const command = (await outbox(db)).find((row) => row.commandType === 'RECIPE_COOK_CHECKIN')!;
      const payload = JSON.parse(command.payloadJson as string) as {
        record: { id: string; itemIds: string[] };
      };
      expect(payload.record.id).toBe(checkin.record.id);
      expect(payload.record.itemIds).toHaveLength(1);
      expect(ledgerRows(target, 'MealRecordItem', ['id'])).toEqual([
        { id: payload.record.itemIds[0] },
      ]);
      expect(count(target, 'InventoryLog')).toBe(0);
      expect(count(target, 'Tag')).toBe(1);
    } finally {
      await db.close();
      target.close();
    }
  });
});

describe('购物清单', () => {
  function shoppingContext(db: DatabaseHandle): ShoppingServiceContext {
    return { database: db, now: () => new Date('2026-11-21T08:00:00Z'), newId: randomId() };
  }

  it('SHOPPING_CHECKIN：入库事实逐行一致，重复命令幂等', async () => {
    const db = await mobile();
    const target = ledger();
    try {
      const replayer = new Replayer(target);
      const ctx = shoppingContext(db);
      const [list] = await listShoppingLists(ctx);
      await addShoppingItem(ctx, list!.id, {
        version: 1,
        ingredientName: '鸡蛋',
        quantity: 10,
        unit: 'PIECE',
      });
      const [item] = await db.query<{ id: string }>('SELECT "id" FROM "ShoppingListItem"');
      await checkInShoppingItems(ctx, list!.id, {
        version: 2,
        operationId: 'op-checkin-1',
        itemIds: [item!.id],
      });
      await replayer.sync(db);
      await compare(target, db, [
        'ShoppingList',
        'ShoppingListItem',
        'ShoppingCheckinOperation',
        'Ingredient',
        'InventoryBatch',
        'InventoryLog',
      ]);

      const command = (await outbox(db)).find((row) => row.commandType === 'SHOPPING_CHECKIN')!;
      expect(replayOperation(target.sql, toOperation(command)).changes).toEqual([]);
      expect(count(target, 'InventoryLog')).toBe(1);
      expect(count(target, 'ShoppingListItem')).toBe(0);
    } finally {
      await db.close();
      target.close();
    }
  });

  it('双人离线勾选/加购不同条目：零 409、零丢项、唯一活跃清单', () => {
    const target = ledger();
    try {
      const timestamp = '2026-11-21T08:00:00.000Z';
      const item = (overrides: Record<string, unknown>) => ({
        id: 'item-a',
        shoppingListId: 'shopping_list_active_default',
        ingredientId: null,
        ingredientNameSnapshot: '番茄',
        quantity: 2,
        unit: 'PIECE',
        amountText: null,
        category: null,
        sourceType: 'MANUAL',
        sourceId: null,
        completed: false,
        sortOrder: 0,
        notes: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        ...overrides,
      });
      const list = (version: number, items: unknown[]) => ({
        id: 'shopping_list_active_default',
        name: '购物清单',
        status: 'ACTIVE',
        notes: null,
        version,
        deletedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        items,
      });

      replayOperation(target.sql, {
        id: 'seed',
        entity: 'ShoppingList',
        entityId: 'shopping_list_active_default',
        kind: 'upsert',
        baseVersion: null,
        payload: payload(list(1, [item({})])),
      });

      // A：勾选 A + 新增 B。
      expect(
        replayOperation(target.sql, {
          id: 'op-a',
          entity: 'ShoppingList',
          entityId: 'shopping_list_active_default',
          kind: 'upsert',
          baseVersion: 1,
          payload: payload(
            list(2, [
              item({ completed: true }),
              item({ id: 'item-b', ingredientNameSnapshot: '鸡蛋', sortOrder: 1 }),
            ]),
          ),
        }).newVersion,
      ).toBe(2);

      // B：基于 v1 只新增 C，不能 409，也不能覆盖 A 的改动。
      expect(
        replayOperation(target.sql, {
          id: 'op-b',
          entity: 'ShoppingList',
          entityId: 'shopping_list_active_default',
          kind: 'upsert',
          baseVersion: 1,
          payload: payload(
            list(2, [item({ id: 'item-c', ingredientNameSnapshot: '面条', sortOrder: 2 })]),
          ),
        }).newVersion,
      ).toBe(3);

      expect(
        target.sql
          .exec<{ id: string; version: number }>(
            `SELECT "id","version" FROM "ShoppingList" WHERE "status" = 'ACTIVE' AND "deletedAt" IS NULL`,
          )
          .toArray(),
      ).toEqual([{ id: 'shopping_list_active_default', version: 3 }]);
      expect(
        target.sql
          .exec<{ id: string; completed: number; quantity: number }>(
            'SELECT "id","completed","quantity" FROM "ShoppingListItem" ORDER BY "id"',
          )
          .toArray(),
      ).toEqual([
        { id: 'item-a', completed: 1, quantity: 2 },
        { id: 'item-b', completed: 0, quantity: 2 },
        { id: 'item-c', completed: 0, quantity: 2 },
      ]);
    } finally {
      target.close();
    }
  });

  it('同一条目双端改动：按基线字段级合并（勾选 + 数量）', () => {
    const target = ledger();
    try {
      const timestamp = '2026-11-21T08:00:00.000Z';
      const base = {
        id: 'item-a',
        shoppingListId: 'shopping_list_active_default',
        ingredientId: null,
        ingredientNameSnapshot: '番茄',
        quantity: 2,
        unit: 'PIECE',
        amountText: null,
        category: null,
        sourceType: 'MANUAL',
        sourceId: null,
        completed: false,
        sortOrder: 0,
        notes: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const list = (version: number, items: unknown[]) => ({
        id: 'shopping_list_active_default',
        name: '购物清单',
        status: 'ACTIVE',
        notes: null,
        version,
        deletedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        items,
      });
      replayOperation(target.sql, {
        id: 'seed',
        entity: 'ShoppingList',
        entityId: 'shopping_list_active_default',
        kind: 'upsert',
        baseVersion: null,
        payload: payload(list(1, [base])),
      });
      replayOperation(target.sql, {
        id: 'server-quantity',
        entity: 'ShoppingList',
        entityId: 'shopping_list_active_default',
        kind: 'upsert',
        baseVersion: 1,
        payload: payload(list(2, [{ ...base, quantity: 5 }])),
      });
      const merged = replayOperation(target.sql, {
        id: 'client-check',
        entity: 'ShoppingList',
        entityId: 'shopping_list_active_default',
        kind: 'upsert',
        baseVersion: 1,
        payload: payload(list(2, [{ ...base, completed: true }])),
      });
      expect(merged.newVersion).toBe(3);
      expect(
        target.sql
          .exec<{ completed: number; quantity: number }>(
            `SELECT "completed","quantity" FROM "ShoppingListItem" WHERE "id" = 'item-a'`,
          )
          .one(),
      ).toEqual({ completed: 1, quantity: 5 });
    } finally {
      target.close();
    }
  });

  it('clearReplayHistory 清空基线，整库替换后不再引用旧快照', () => {
    const target = ledger();
    try {
      replayOperation(target.sql, {
        id: 'seed',
        entity: 'ShoppingList',
        entityId: 'shopping_list_active_default',
        kind: 'upsert',
        baseVersion: null,
        payload: {
          id: 'shopping_list_active_default',
          name: '购物清单',
          status: 'ACTIVE',
          notes: null,
          version: 1,
          deletedAt: null,
          createdAt: '2026-11-21T08:00:00.000Z',
          updatedAt: '2026-11-21T08:00:00.000Z',
          items: [],
        },
      });
      expect(count(target, 'sync_replay_history')).toBeGreaterThan(0);
      clearReplayHistory(target.sql);
      expect(count(target, 'sync_replay_history')).toBe(0);
    } finally {
      target.close();
    }
  });
});

describe('排餐槽位冲突', () => {
  it('同日同餐次离线新建不同 id：后到方返回 PLAN_SLOT_CONFLICT 并附胜出摘要', () => {
    const target = ledger();
    try {
      const timestamp = '2026-11-21T08:00:00.000Z';
      const plan = (id: string) => ({
        id,
        planDate: '2026-11-21',
        mealType: 'DINNER',
        dinerCount: 1,
        status: 'PLANNED',
        notes: null,
        time: null,
        title: null,
        subtext: null,
        icon: null,
        version: 1,
        completedAt: null,
        deletedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        items: [],
        diners: [],
      });
      replayOperation(target.sql, {
        id: 'op-plan-a',
        entity: 'MealPlan',
        entityId: 'plan-a',
        kind: 'upsert',
        baseVersion: null,
        payload: plan('plan-a'),
      });

      let rejection: ReplayConflict | undefined;
      try {
        replayOperation(target.sql, {
          id: 'op-plan-b',
          entity: 'MealPlan',
          entityId: 'plan-b',
          kind: 'upsert',
          baseVersion: null,
          payload: plan('plan-b'),
        });
      } catch (error) {
        rejection = error as ReplayConflict;
      }
      expect(rejection).toBeInstanceOf(ReplayConflict);
      expect(rejection?.rejection).toMatchObject({
        operationId: 'op-plan-b',
        code: 'PLAN_SLOT_CONFLICT',
        serverVersion: 1,
      });
      expect(rejection?.rejection.winner).toMatchObject({ id: 'plan-a', planDate: '2026-11-21' });
      expect(count(target, 'MealPlan')).toBe(1);
    } finally {
      target.close();
    }
  });

  it('另一天/另一餐次不冲突', () => {
    const target = ledger();
    try {
      const timestamp = '2026-11-21T08:00:00.000Z';
      const plan = (id: string, planDate: string, mealType: string) => ({
        id,
        planDate,
        mealType,
        dinerCount: 1,
        status: 'PLANNED',
        version: 1,
        deletedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        items: [],
        diners: [],
      });
      replayOperation(target.sql, {
        id: 'op-1',
        entity: 'MealPlan',
        entityId: 'p1',
        kind: 'upsert',
        baseVersion: null,
        payload: plan('p1', '2026-11-21', 'DINNER'),
      });
      replayOperation(target.sql, {
        id: 'op-2',
        entity: 'MealPlan',
        entityId: 'p2',
        kind: 'upsert',
        baseVersion: null,
        payload: plan('p2', '2026-11-22', 'DINNER'),
      });
      expect(count(target, 'MealPlan')).toBe(2);
    } finally {
      target.close();
    }
  });
});

describe('删除与版本', () => {
  it('软删只更新 deletedAt/version 并返回完整行；版本不符拒绝', () => {
    const target = ledger();
    try {
      const timestamp = '2026-11-21T08:00:00.000Z';
      replayOperation(target.sql, {
        id: 'op-tool',
        entity: 'KitchenTool',
        entityId: 'tool-1',
        kind: 'upsert',
        baseVersion: null,
        payload: {
          id: 'tool-1',
          name: '炒锅',
          imagePath: null,
          icon: null,
          category: null,
          quantity: 1,
          status: null,
          notes: null,
          version: 1,
          deletedAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      });
      const removed = replayOperation(target.sql, {
        id: 'op-tool-delete',
        entity: 'KitchenTool',
        entityId: 'tool-1',
        kind: 'delete',
        baseVersion: 1,
        deletedAt: '2026-11-21T09:00:00.000Z',
      });
      expect(removed.newVersion).toBe(2);
      expect(removed.changes[0]?.row).toMatchObject({
        id: 'tool-1',
        deletedAt: '2026-11-21T09:00:00.000Z',
        version: 2,
      });
      expect(() =>
        replayOperation(target.sql, {
          id: 'op-tool-delete-2',
          entity: 'KitchenTool',
          entityId: 'tool-1',
          kind: 'delete',
          baseVersion: 1,
          deletedAt: '2026-11-21T10:00:00.000Z',
        }),
      ).toThrow(ReplayConflict);
    } finally {
      target.close();
    }
  });

  it('聚合子表随父行重放；软删保留子表且 Tag 删除写 deletedAt', () => {
    const target = ledger();
    try {
      const timestamp = '2026-11-21T08:00:00.000Z';
      replayOperation(target.sql, {
        id: 'op-recipe',
        entity: 'Recipe',
        entityId: 'recipe-1',
        kind: 'upsert',
        baseVersion: null,
        payload: {
          id: 'recipe-1',
          name: '番茄炒蛋',
          category: null,
          imagePath: null,
          ingredientsText: null,
          cookingTimeMinutes: null,
          difficulty: null,
          spicyLevel: null,
          servings: null,
          calories: null,
          sourceNote: null,
          notes: null,
          favorite: false,
          enabledForRecommendation: true,
          version: 1,
          deletedAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          ingredients: [
            {
              id: 'ri-1',
              recipeId: 'recipe-1',
              ingredientId: null,
              ingredientNameSnapshot: '番茄',
              quantity: 1,
              unit: 'PIECE',
              amountText: null,
              optional: false,
              isPrimary: true,
              sortOrder: 0,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
          steps: [
            {
              id: 'step-1',
              recipeId: 'recipe-1',
              stepNo: 1,
              content: '炒',
              title: null,
              timerMinutes: null,
              imagePath: null,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
          tags: [
            {
              id: 'rt-1',
              recipeId: 'recipe-1',
              tagId: 'tag-1',
              createdAt: timestamp,
              updatedAt: timestamp,
              tag: {
                id: 'tag-1',
                name: '快手菜',
                type: 'GENERAL',
                deletedAt: null,
                version: 1,
                createdAt: timestamp,
                updatedAt: timestamp,
              },
            },
          ],
          mealTypes: [
            {
              id: 'rmt-1',
              recipeId: 'recipe-1',
              mealType: 'DINNER',
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
          mealRoles: [],
          tools: [],
        },
      });
      expect(count(target, 'RecipeIngredient')).toBe(1);
      expect(count(target, 'RecipeStep')).toBe(1);
      expect(count(target, 'RecipeTag')).toBe(1);
      expect(count(target, 'Tag')).toBe(1);
      expect(count(target, 'RecipeMealType')).toBe(1);

      const op: SyncOperation = {
        id: 'op-recipe-delete',
        entity: 'Recipe',
        entityId: 'recipe-1',
        kind: 'delete',
        baseVersion: 1,
        deletedAt: '2026-11-21T09:00:00.000Z',
      };
      const removed = replayOperation(target.sql, op);
      expect(removed.newVersion).toBe(2);
      // Recipe 是软删（子表保留，端侧同语义）。
      expect(count(target, 'RecipeIngredient')).toBe(1);
      expect(removed.changes.find((change) => change.table === 'Recipe')?.row).toMatchObject({
        deletedAt: '2026-11-21T09:00:00.000Z',
      });

      // 物理删除级联：RecipeTag（无软删列）删除 Tag 父行前的关联行。
      const tagRemoval = replayOperation(target.sql, {
        id: 'op-tag-delete',
        entity: 'Tag',
        entityId: 'tag-1',
        kind: 'delete',
        baseVersion: 1,
        deletedAt: '2026-11-21T09:30:00.000Z',
      });
      expect(count(target, 'RecipeTag')).toBe(1);
      expect(tagRemoval.changes.find((change) => change.table === 'Tag')?.row).toMatchObject({
        deletedAt: '2026-11-21T09:30:00.000Z',
      });
    } finally {
      target.close();
    }
  });
});

describe('端侧同一事务复现', () => {
  it('replayOperation 的 changes 可在空端库按序 applyRowChanges，且外键不违约', async () => {
    const db = await mobile();
    const target = ledger();
    const replica = await mobile();
    try {
      const replayer = new Replayer(target);
      const now = () => new Date('2026-11-21T08:00:00Z');
      const ingredient = await createIngredient(
        { database: db, now },
        {
          name: '鸡蛋',
          unit: 'PIECE',
          batches: [{ quantity: 4, unit: 'PIECE' }],
        },
      );
      await consumeIngredient({ database: db, now }, ingredient.id, {
        mode: 'QUANTITY',
        quantity: 1,
        unit: 'PIECE',
        ingredientVersion: 1,
      });
      const plan = await createPlan(
        { database: db, now, newId: randomId() },
        {
          planDate: '2026-11-25',
          mealType: 'DINNER',
          dinerCount: 1,
          status: 'PLANNED',
          notes: null,
          time: null,
          title: null,
          subtext: null,
          icon: null,
          items: [
            {
              itemType: 'CUSTOM',
              mealRole: 'MAIN',
              recipeId: null,
              storeId: null,
              customName: '煎蛋',
              sortOrder: 0,
            },
          ],
          dinerIds: [],
        },
      );
      await completePlan({ database: db, now, newId: randomId() }, plan.id, 1);

      const operations = await replayer.drain(db);
      for (const operation of operations) {
        const result = replayOperation(target.sql, operation);
        await replica.withWriteTransaction(async (tx) => {
          for (const change of result.changes) {
            if (change.row === null) {
              await tx.run(`DELETE FROM "${change.table}" WHERE "id" = ?`, [change.id]);
              continue;
            }
            // 已存在的行必须 UPDATE：INSERT OR REPLACE 会先删父行，触发
            // InventoryLog 等 ON DELETE SET NULL 级联，把子行外键清空。
            const [existing] = await tx.query<{ id: string | number }>(
              `SELECT "id" FROM "${change.table}" WHERE "id" = ?`,
              [change.id],
            );
            const entries = Object.entries(change.row);
            if (existing) {
              const assignments = entries
                .filter(([column]) => column !== 'id')
                .map(([column]) => `"${column}" = ?`);
              if (!assignments.length) continue;
              await tx.run(
                `UPDATE "${change.table}" SET ${assignments.join(', ')} WHERE "id" = ?`,
                [
                  ...entries
                    .filter(([column]) => column !== 'id')
                    .map(([, value]) => value as string | number | null),
                  change.id,
                ],
              );
            } else {
              await tx.run(
                `INSERT INTO "${change.table}" (${entries.map(([column]) => `"${column}"`).join(', ')})
                 VALUES (${entries.map(() => '?').join(', ')})`,
                entries.map(([, value]) => value as string | number | null),
              );
            }
          }
        });
      }

      await compare(target, replica, [
        'Ingredient',
        'InventoryBatch',
        'InventoryLog',
        'MealPlan',
        'MealPlanItem',
        'MealRecord',
        'MealRecordItem',
      ]);
      const violations = await replica.query<Record<string, unknown>>('PRAGMA foreign_key_check');
      expect(violations).toEqual([]);
    } finally {
      await db.close();
      target.close();
      replica.close();
    }
  });
});

describe('Settings 与 UploadAsset', () => {
  it('Settings 固定 id=1 并按载荷 version 推进', () => {
    const target = ledger();
    try {
      const timestamp = '2026-11-21T08:00:00.000Z';
      const base = {
        id: 1,
        appName: '搭饭小馆',
        subtitle: '让每一餐都更美好',
        defaultPort: 8787,
        autoBackupEnabled: true,
        autoDeductInventory: false,
        defaultRepeatDays: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const updated = replayOperation(target.sql, {
        id: 'op-settings',
        entity: 'Settings',
        entityId: '1',
        kind: 'upsert',
        baseVersion: 1,
        payload: payload({ ...base, appName: '我家小馆', version: 2 }),
      });
      expect(updated.newVersion).toBe(2);
      expect(
        target.sql
          .exec<{ id: number; appName: string; version: number }>(
            'SELECT "id","appName","version" FROM "Settings"',
          )
          .one(),
      ).toEqual({ id: 1, appName: '我家小馆', version: 2 });
    } finally {
      target.close();
    }
  });

  it('UploadAsset 无 version 列，按 filename/storagePath 对齐并忽略多余 version', () => {
    const target = ledger();
    try {
      const timestamp = '2026-11-21T08:00:00.000Z';
      const asset = {
        id: 'asset-1',
        filename: 'main-1.webp',
        storagePath: 'main-1.webp',
        thumbnailPath: 'thumb-1.webp',
        mimeType: 'image/webp',
        sizeBytes: 128,
        sha256: 'a'.repeat(64),
        width: 10,
        height: 10,
        recipeId: null,
        storeId: null,
        mealRecordId: null,
        deletedAt: null,
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      replayOperation(target.sql, {
        id: 'op-asset',
        entity: 'UploadAsset',
        entityId: 'asset-1',
        kind: 'upsert',
        baseVersion: null,
        payload: payload(asset),
      });
      // 同一 filename 的另一 id（结构漂移/旧版本重放）必须对齐到既有行。
      replayOperation(target.sql, {
        id: 'op-asset-2',
        entity: 'UploadAsset',
        entityId: 'asset-2',
        kind: 'upsert',
        baseVersion: null,
        payload: payload({ ...asset, id: 'asset-2', sha256: 'b'.repeat(64), version: 3 }),
      });
      const rows = target.sql
        .exec<{ id: string; sha256: string }>('SELECT "id","sha256" FROM "UploadAsset"')
        .toArray();
      expect(rows).toEqual([{ id: 'asset-1', sha256: 'b'.repeat(64) }]);
      expect(
        target.sql
          .exec<{ name: string }>('PRAGMA table_info("UploadAsset")')
          .toArray()
          .map(({ name }) => name),
      ).not.toContain('version');
    } finally {
      target.close();
    }
  });
});
