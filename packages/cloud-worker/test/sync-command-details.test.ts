import { describe, expect, it } from 'vitest';

import type { SyncOperation } from '@dafan/shared/sync';

import { replayOperation, ReplayConflict } from '../src/sync-replay';
import { ledger, type Ledger } from './sync-replay-helpers';

const TS = '2026-11-21T08:00:00.000Z';
const LIST = 'shopping_list_active_default';

function item(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    shoppingListId: LIST,
    ingredientId: null,
    ingredientNameSnapshot: id,
    quantity: 1,
    unit: 'PIECE',
    amountText: null,
    category: null,
    sourceType: 'MANUAL',
    sourceId: null,
    completed: false,
    sortOrder: 0,
    notes: null,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

function list(version: number, items: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: LIST,
    name: '购物清单',
    status: 'ACTIVE',
    notes: null,
    version,
    deletedAt: null,
    createdAt: TS,
    updatedAt: TS,
    items,
    ...extra,
  };
}

function rowsOf(target: Ledger, table: string): Record<string, unknown>[] {
  return target.sql.exec(`SELECT * FROM "${table}" ORDER BY "id"`).toArray() as unknown as Record<
    string,
    unknown
  >[];
}

function seed(target: Ledger, items: unknown[] = [item('item-a')]): void {
  replayOperation(target.sql, {
    id: 'seed',
    entity: 'ShoppingList',
    entityId: LIST,
    kind: 'upsert',
    baseVersion: null,
    payload: list(1, items) as never,
  });
}

describe('购物单连续离线修改（baseItems）', () => {
  it('baseVersion 等于云端版本时仍按 baseItems 做三方合并，不覆盖他人并发新增项', () => {
    const target = ledger();
    try {
      seed(target);
      // 另一台设备先勾选 item-a 并新增 item-b（云端推进到 v2）。
      replayOperation(target.sql, {
        id: 'other-op',
        entity: 'ShoppingList',
        entityId: LIST,
        kind: 'upsert',
        baseVersion: 1,
        payload: list(2, [
          item('item-a', { shoppingListId: LIST }),
          item('item-b', { shoppingListId: LIST, sortOrder: 1 }),
        ]) as never,
      });

      // 本设备串行本地修改：本地 version 已随本地历史推到 2，与云端相同。
      // 本次操作的基线是本地 v2 前的完整条目快照（只有 item-a）。
      const merged = replayOperation(target.sql, {
        id: 'offline-op',
        entity: 'ShoppingList',
        entityId: LIST,
        kind: 'upsert',
        baseVersion: 2,
        payload: list(2, [item('item-a', { shoppingListId: LIST, completed: true })], {
          baseItems: [item('item-a', { shoppingListId: LIST })],
        }) as never,
      });
      expect(merged.newVersion).toBe(3);

      const items = rowsOf(target, 'ShoppingListItem');
      expect(items.map((row) => row.id)).toEqual(['item-a', 'item-b']);
      expect(items.find((row) => row.id === 'item-a')?.completed).toBe(1);
      // 云端新增的 item-b 未被误删。
      expect(items.find((row) => row.id === 'item-b')).toBeTruthy();
    } finally {
      target.close();
    }
  });

  it('多次串行本地修改合并：第二次修改以本地快照为基线，字段级合并不丢双方改动', () => {
    const target = ledger();
    try {
      seed(target, [item('item-a'), item('item-b', { sortOrder: 1 })]);
      // 设备 A 两次离线修改：v1 → 勾选 a；再基于本地快照 → 改 b 数量。
      replayOperation(target.sql, {
        id: 'local-1',
        entity: 'ShoppingList',
        entityId: LIST,
        kind: 'upsert',
        baseVersion: 1,
        payload: list(2, [
          item('item-a', { completed: true }),
          item('item-b', { sortOrder: 1 }),
        ]) as never,
      });
      // 设备 B 基于 v2 把 a 的数量改成 5。
      replayOperation(target.sql, {
        id: 'remote-1',
        entity: 'ShoppingList',
        entityId: LIST,
        kind: 'upsert',
        baseVersion: 2,
        payload: list(3, [
          item('item-a', { completed: true, quantity: 5 }),
          item('item-b', { sortOrder: 1 }),
        ]) as never,
      });
      // 设备 A 的第二次修改（本地 version 也是 3，与云端相同）。
      const merged = replayOperation(target.sql, {
        id: 'local-2',
        entity: 'ShoppingList',
        entityId: LIST,
        kind: 'upsert',
        baseVersion: 3,
        payload: list(
          3,
          [item('item-a', { completed: true }), item('item-b', { sortOrder: 1, quantity: 7 })],
          {
            baseItems: [item('item-a', { completed: true }), item('item-b', { sortOrder: 1 })],
          },
        ) as never,
      });
      expect(merged.newVersion).toBe(4);
      const items = rowsOf(target, 'ShoppingListItem');
      expect(items.find((row) => row.id === 'item-a')).toMatchObject({ completed: 1, quantity: 5 });
      expect(items.find((row) => row.id === 'item-b')).toMatchObject({ quantity: 7 });
    } finally {
      target.close();
    }
  });

  it('旧载荷无 baseItems 时回退到服务端版本基线（既有行为不变）', () => {
    const target = ledger();
    try {
      seed(target);
      replayOperation(target.sql, {
        id: 'other-op',
        entity: 'ShoppingList',
        entityId: LIST,
        kind: 'upsert',
        baseVersion: 1,
        payload: list(2, [item('item-a'), item('item-b', { sortOrder: 1, quantity: 3 })]) as never,
      });
      const merged = replayOperation(target.sql, {
        id: 'legacy-op',
        entity: 'ShoppingList',
        entityId: LIST,
        kind: 'upsert',
        baseVersion: 1,
        payload: list(2, [item('item-a', { completed: true })]) as never,
      });
      expect(merged.newVersion).toBe(3);
      expect(rowsOf(target, 'ShoppingListItem').map((row) => row.id)).toEqual(['item-a', 'item-b']);
    } finally {
      target.close();
    }
  });
});

function planRow(id: string, version = 1, overrides: Record<string, unknown> = {}) {
  return {
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
    version,
    completedAt: null,
    deletedAt: null,
    createdAt: TS,
    updatedAt: TS,
    items: [],
    diners: [],
    ...overrides,
  };
}

describe('PLAN_UNCOMPLETE 乐观锁与状态守卫', () => {
  function recordRow(id: string, version: number, status = 'DRAFT') {
    return {
      id,
      recordDate: '2026-11-21',
      recordTime: null,
      mealType: 'DINNER',
      sourceType: 'HOMEMADE',
      status,
      title: null,
      relatedPlanId: 'plan-1',
      sourceMealPlanId: 'plan-1',
      confirmedAt: status === 'CONFIRMED' ? TS : null,
      version,
      deletedAt: null,
      createdAt: TS,
      updatedAt: TS,
      itemIds: [],
      dinerRowIds: [],
    };
  }

  function complete(target: Ledger, recordVersion = 1): void {
    replayOperation(target.sql, {
      id: 'op-plan',
      entity: 'MealPlan',
      entityId: 'plan-1',
      kind: 'upsert',
      baseVersion: null,
      payload: planRow('plan-1') as never,
    });
    replayOperation(target.sql, {
      id: 'op-complete',
      entity: 'MealPlan',
      entityId: 'plan-1',
      kind: 'command',
      commandType: 'PLAN_COMPLETE',
      baseVersion: 1,
      payloadHash: 'a'.repeat(64),
      payload: {
        id: 'plan-1',
        baseVersion: 1,
        executedAt: TS,
        plan: { ...planRow('plan-1', 2, { status: 'COMPLETED', completedAt: TS }) },
        record: recordRow('record-1', recordVersion),
        recordCreated: true,
        recordRevived: false,
      } as never,
    });
  }

  function uncomplete(recordVersion = 2): SyncOperation {
    return {
      id: 'op-uncomplete',
      entity: 'MealPlan',
      entityId: 'plan-1',
      kind: 'command',
      commandType: 'PLAN_UNCOMPLETE',
      baseVersion: 2,
      payloadHash: 'b'.repeat(64),
      payload: {
        id: 'plan-1',
        baseVersion: 2,
        executedAt: '2026-11-22T00:00:00.000Z',
        plan: planRow('plan-1', 3),
        removedRecord: {
          id: 'record-1',
          version: recordVersion,
          deletedAt: '2026-11-22T00:00:00.000Z',
          planUncompleteProof: '{"origin":"PLAN_UNCOMPLETE"}',
        },
      } as never,
    };
  }

  it('未改动草稿可被撤销：记录软删并写入 provenance', () => {
    const target = ledger();
    try {
      complete(target);
      const result = replayOperation(target.sql, uncomplete());
      expect(result.newVersion).toBe(3);
      expect(rowsOf(target, 'MealRecord')[0]).toMatchObject({
        deletedAt: '2026-11-22T00:00:00.000Z',
        planUncompleteProof: '{"origin":"PLAN_UNCOMPLETE"}',
        version: 2,
      });
      expect(rowsOf(target, 'MealPlan')[0]).toMatchObject({ status: 'PLANNED', version: 3 });
    } finally {
      target.close();
    }
  });

  it('已 CONFIRMED 记录拒绝撤销，且零落库', () => {
    const target = ledger();
    try {
      complete(target);
      target.sql.exec(`UPDATE "MealRecord" SET "status" = 'CONFIRMED'`);
      let conflict: unknown;
      try {
        replayOperation(target.sql, uncomplete());
      } catch (error) {
        conflict = error;
      }
      expect(conflict).toBeInstanceOf(ReplayConflict);
      expect((conflict as ReplayConflict).rejection).toMatchObject({
        code: 'VERSION_CONFLICT',
        serverVersion: 1,
      });
      expect(rowsOf(target, 'MealRecord')[0]).toMatchObject({ deletedAt: null, version: 1 });
      expect(rowsOf(target, 'MealPlan')[0]).toMatchObject({ status: 'COMPLETED', version: 2 });
    } finally {
      target.close();
    }
  });

  it('记录版本已被他人推进时拒绝撤销', () => {
    const target = ledger();
    try {
      complete(target);
      expect(() => replayOperation(target.sql, uncomplete())).not.toThrow();
      // 第二台设备仍拿着旧记录版本重推同一撤销。
      expect(() => replayOperation(target.sql, uncomplete())).toThrow(ReplayConflict);
    } finally {
      target.close();
    }
  });
});

describe('replaceRecordChildren 与菜谱子表重排', () => {
  it('PLAN_COMPLETE 复活时旧记录子行的物理删除进入变更日志', () => {
    const target = ledger();
    try {
      replayOperation(target.sql, {
        id: 'op-plan',
        entity: 'MealPlan',
        entityId: 'plan-1',
        kind: 'upsert',
        baseVersion: null,
        payload: planRow('plan-1', 1, {
          items: [
            {
              id: 'pi-1',
              mealPlanId: 'plan-1',
              itemType: 'CUSTOM',
              mealRole: 'MAIN',
              recipeId: null,
              storeId: null,
              customName: '番茄炒蛋',
              sortOrder: 0,
              createdAt: TS,
              updatedAt: TS,
            },
          ],
        }) as never,
      });
      replayOperation(target.sql, {
        id: 'op-complete',
        entity: 'MealPlan',
        entityId: 'plan-1',
        kind: 'command',
        commandType: 'PLAN_COMPLETE',
        baseVersion: 1,
        payloadHash: 'a'.repeat(64),
        payload: {
          id: 'plan-1',
          baseVersion: 1,
          executedAt: TS,
          plan: { ...planRow('plan-1', 2, { status: 'COMPLETED', completedAt: TS }) },
          record: {
            id: 'record-1',
            recordDate: '2026-11-21',
            recordTime: null,
            mealType: 'DINNER',
            sourceType: 'HOMEMADE',
            status: 'DRAFT',
            title: null,
            relatedPlanId: 'plan-1',
            sourceMealPlanId: 'plan-1',
            confirmedAt: null,
            version: 1,
            deletedAt: null,
            createdAt: TS,
            updatedAt: TS,
            itemIds: ['old-item'],
            dinerRowIds: [],
          },
          recordCreated: true,
          recordRevived: false,
        } as never,
      });
      // 计划被撤销完成，记录软删但保留旧条目。
      replayOperation(target.sql, {
        id: 'op-uncomplete',
        entity: 'MealPlan',
        entityId: 'plan-1',
        kind: 'command',
        commandType: 'PLAN_UNCOMPLETE',
        baseVersion: 2,
        payloadHash: 'b'.repeat(64),
        payload: {
          id: 'plan-1',
          baseVersion: 2,
          executedAt: '2026-11-22T00:00:00.000Z',
          plan: planRow('plan-1', 3),
          removedRecord: {
            id: 'record-1',
            version: 2,
            deletedAt: '2026-11-22T00:00:00.000Z',
            planUncompleteProof: '{"origin":"PLAN_UNCOMPLETE"}',
          },
        } as never,
      });
      expect(rowsOf(target, 'MealRecordItem').map((row) => row.id)).toEqual(['old-item']);

      // 再次完成 → 复活：旧条目必须被物理删除并出现在变更日志里。
      const revived = replayOperation(target.sql, {
        id: 'op-complete-2',
        entity: 'MealPlan',
        entityId: 'plan-1',
        kind: 'command',
        commandType: 'PLAN_COMPLETE',
        baseVersion: 3,
        payloadHash: 'c'.repeat(64),
        payload: {
          id: 'plan-1',
          baseVersion: 3,
          executedAt: '2026-11-23T00:00:00.000Z',
          plan: { ...planRow('plan-1', 4, { status: 'COMPLETED', completedAt: TS }) },
          record: {
            id: 'record-1',
            recordDate: '2026-11-21',
            recordTime: null,
            mealType: 'DINNER',
            sourceType: 'HOMEMADE',
            status: 'DRAFT',
            title: null,
            relatedPlanId: 'plan-1',
            sourceMealPlanId: 'plan-1',
            confirmedAt: null,
            version: 3,
            deletedAt: '2026-11-22T00:00:00.000Z',
            createdAt: TS,
            updatedAt: TS,
            itemIds: [],
            dinerRowIds: [],
          },
          recordCreated: false,
          recordRevived: true,
        } as never,
      });
      const removals = revived.changes.filter(
        (change) => change.table === 'MealRecordItem' && change.row === null,
      );
      expect(removals.map((change) => change.id)).toEqual(['old-item']);
      expect(rowsOf(target, 'MealRecordItem')).toEqual([]);
      // 删除先于任何写入，端侧按序 apply 不会外键失败。
      const firstWrite = revived.changes.findIndex((change) => change.row !== null);
      const lastRemoval = revived.changes.reduce(
        (index, change, current) => (change.row === null ? current : index),
        -1,
      );
      expect(lastRemoval).toBeLessThan(firstWrite);
    } finally {
      target.close();
    }
  });

  it('RecipeStep 同一 stepNo 换主键：先剪枝再插入，不撞唯一索引', () => {
    const target = ledger();
    try {
      const step = (id: string) => ({
        id,
        recipeId: 'recipe-1',
        stepNo: 1,
        content: '炒',
        title: null,
        timerMinutes: null,
        imagePath: null,
        createdAt: TS,
        updatedAt: TS,
      });
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
          createdAt: TS,
          updatedAt: TS,
          ingredients: [],
          steps: [step('step-old')],
          tags: [],
          mealTypes: [],
          mealRoles: [],
          tools: [],
        } as never,
      });
      const updated = replayOperation(target.sql, {
        id: 'op-recipe-2',
        entity: 'Recipe',
        entityId: 'recipe-1',
        kind: 'upsert',
        baseVersion: 1,
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
          version: 2,
          deletedAt: null,
          createdAt: TS,
          updatedAt: TS,
          ingredients: [],
          steps: [step('step-new')],
          tags: [],
          mealTypes: [],
          mealRoles: [],
          tools: [],
        } as never,
      });
      expect(rowsOf(target, 'RecipeStep').map((row) => row.id)).toEqual(['step-new']);
      const order = updated.changes.map(
        (change) => `${change.table}:${String(change.id)}:${change.row === null ? 'del' : 'set'}`,
      );
      expect(order).toEqual([
        'RecipeStep:step-old:del',
        'Recipe:recipe-1:set',
        'RecipeStep:step-new:set',
      ]);
    } finally {
      target.close();
    }
  });
});

describe('SHOPPING_CHECKIN 空库存换单位', () => {
  function listRow(version = 1) {
    return {
      id: LIST,
      name: '购物清单',
      status: 'ACTIVE',
      notes: null,
      version,
      deletedAt: null,
      createdAt: TS,
      updatedAt: TS,
    };
  }

  it('先写批次再按端侧口径重算：基础单位对齐本批次单位、数量与元数据同步', () => {
    const target = ledger();
    try {
      // 既有食材：零库存（quantity=0、无活批次），历史单位是 OTHER（与 PIECE 不可换算）。
      replayOperation(target.sql, {
        id: 'op-ing',
        entity: 'Ingredient',
        entityId: 'ing-1',
        kind: 'upsert',
        baseVersion: null,
        payload: {
          id: 'ing-1',
          name: '鸡蛋',
          imagePath: null,
          category: '蛋奶',
          quantity: 0,
          unit: 'OTHER',
          purchaseDate: null,
          expiryDate: null,
          location: null,
          minStock: null,
          maxStock: null,
          opened: false,
          notes: null,
          version: 1,
          deletedAt: null,
          createdAt: TS,
          updatedAt: TS,
          batches: [],
          inventoryLogs: [],
        } as never,
      });
      replayOperation(target.sql, {
        id: 'op-list',
        entity: 'ShoppingList',
        entityId: LIST,
        kind: 'upsert',
        baseVersion: null,
        payload: {
          ...listRow(),
          items: [item('item-a', { ingredientId: 'ing-1', quantity: 10 })],
        } as never,
      });

      const result = replayOperation(target.sql, {
        id: 'op-checkin',
        entity: 'ShoppingList',
        entityId: LIST,
        kind: 'command',
        commandType: 'SHOPPING_CHECKIN',
        baseVersion: 1,
        payloadHash: 'a'.repeat(64),
        payload: {
          shoppingListId: LIST,
          baseVersion: 1,
          executedAt: TS,
          listVersion: 2,
          purchaseDate: '2026-11-21',
          request: {
            shoppingListId: LIST,
            baseVersion: 1,
            operationId: 'op-c',
            itemIds: ['item-a'],
          },
          items: [],
          inventory: [
            {
              kind: 'INGREDIENT_IMPORT',
              createdIngredient: false,
              ingredientId: 'ing-1',
              ingredientNameSnapshot: '鸡蛋',
              ingredientUnit: 'PIECE',
              ingredientQuantity: 10,
              ingredientBaseVersion: 1,
              ingredientVersion: 2,
              ingredientCategory: '蛋奶',
              batchId: 'batch-1',
              batchQuantity: 10,
              batchUnit: 'PIECE',
              logId: 'log-1',
              beforeQuantity: 0,
              afterQuantity: 10,
              executedAt: TS,
            },
          ],
          operation: {
            id: 'op-c',
            shoppingListId: LIST,
            payloadHash: 'b'.repeat(64),
            resultJson: '{}',
            createdAt: TS,
          },
        } as never,
      });

      expect(result.newVersion).toBe(2);
      expect(rowsOf(target, 'Ingredient')[0]).toMatchObject({
        id: 'ing-1',
        unit: 'PIECE',
        quantity: 10,
        purchaseDate: '2026-11-21',
        category: '蛋奶',
        version: 2,
        deletedAt: null,
      });
      expect(rowsOf(target, 'InventoryBatch')).toEqual([
        expect.objectContaining({
          id: 'batch-1',
          ingredientId: 'ing-1',
          quantity: 10,
          unit: 'PIECE',
          deletedAt: null,
        }),
      ]);
      expect(rowsOf(target, 'InventoryLog')).toEqual([
        expect.objectContaining({ id: 'log-1', changeType: 'PURCHASE', changeQuantity: 10 }),
      ]);
      // 入库后补齐清单基线，后续离线设备可基于该版本做字段级合并。
      expect(
        target.sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM "sync_replay_history"
              WHERE "table_name" = 'ShoppingList' AND "row_id" = ? AND "version" = 2`,
            LIST,
          )
          .one().count,
      ).toBe(1);
    } finally {
      target.close();
    }
  });
});
