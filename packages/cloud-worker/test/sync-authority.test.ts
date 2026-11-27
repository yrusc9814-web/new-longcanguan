import { describe, expect, it } from 'vitest';

import type { SyncOperation } from '@dafan/shared/sync';

import { authoritativeRejection } from '../src/sync-authority';
import { ChangeCollector, ReplayConflict } from '../src/sync-replay-support';
import { replayOperation } from '../src/sync-replay';
import { ledger, type Ledger } from './sync-replay-helpers';

const TS = '2026-11-21T08:00:00.000Z';
const LIST = 'shopping_list_active_default';

function planPayload(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    version: 1,
    completedAt: null,
    deletedAt: null,
    createdAt: TS,
    updatedAt: TS,
    items: [],
    diners: [],
    ...overrides,
  };
}

function rowsOf(target: Ledger, table: string): Record<string, unknown>[] {
  return target.sql.exec(`SELECT * FROM "${table}" ORDER BY "id"`).toArray() as unknown as Record<
    string,
    unknown
  >[];
}

function idsOf(target: Ledger, table: string): string[] {
  return rowsOf(target, table).map((row) => String(row.id));
}

function capture<T>(action: () => T): ReplayConflict {
  try {
    action();
  } catch (error) {
    if (error instanceof ReplayConflict) return error;
    throw error;
  }
  throw new Error('expected ReplayConflict');
}

describe('ChangeCollector 排序：先删后写', () => {
  it('物理删除按子表优先排在任何写入之前，写入按父表优先', () => {
    const target = ledger();
    try {
      const changes = new ChangeCollector(target.sql);
      changes.record('InventoryLog', 'log-1', { id: 'log-1' } as never);
      changes.record('Recipe', 'recipe-1', { id: 'recipe-1' } as never);
      changes.record('RecipeStep', 'step-new', { id: 'step-new' } as never);
      changes.record('InventoryBatch', 'batch-old', null);
      changes.record('MealRecordItem', 'item-old', null);
      const order = changes.list().map((change) => `${change.table}:${String(change.id)}`);
      expect(order).toEqual([
        'MealRecordItem:item-old',
        'InventoryBatch:batch-old',
        'Recipe:recipe-1',
        'RecipeStep:step-new',
        'InventoryLog:log-1',
      ]);
    } finally {
      target.close();
    }
  });
});

describe('冲突拒绝附带权威聚合行', () => {
  it('PLAN_SLOT_CONFLICT：被拒根不存在 → rows 为空，胜出计划带完整子行', () => {
    const target = ledger();
    try {
      replayOperation(target.sql, {
        id: 'op-a',
        entity: 'MealPlan',
        entityId: 'plan-a',
        kind: 'upsert',
        baseVersion: null,
        payload: planPayload('plan-a', {
          items: [
            {
              id: 'mpi-a',
              mealPlanId: 'plan-a',
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
      const conflict = capture(() =>
        replayOperation(target.sql, {
          id: 'op-b',
          entity: 'MealPlan',
          entityId: 'plan-b',
          kind: 'upsert',
          baseVersion: null,
          payload: planPayload('plan-b') as never,
        }),
      );
      const operation = conflict.operation as SyncOperation;
      const rejection = authoritativeRejection(target.sql, operation, conflict.rejection);
      expect(rejection.code).toBe('PLAN_SLOT_CONFLICT');
      expect(rejection.authoritative).toHaveLength(2);
      const [rejectedRoot, winner] = rejection.authoritative!;
      expect(rejectedRoot).toEqual({ entity: 'MealPlan', entityId: 'plan-b', rows: [] });
      expect(winner?.entity).toBe('MealPlan');
      expect(winner?.entityId).toBe('plan-a');
      expect(winner?.rows.map((change) => `${change.table}:${String(change.id)}`)).toEqual([
        'MealPlan:plan-a',
        'MealPlanItem:mpi-a',
      ]);
    } finally {
      target.close();
    }
  });

  it('SHOPPING_CHECKIN 拒绝时：清单单元含全部条目，入库食材各成单元（含批次与日志）', () => {
    const target = ledger();
    try {
      replayOperation(target.sql, {
        id: 'seed',
        entity: 'ShoppingList',
        entityId: LIST,
        kind: 'upsert',
        baseVersion: null,
        payload: {
          id: LIST,
          name: '购物清单',
          status: 'ACTIVE',
          notes: null,
          version: 1,
          deletedAt: null,
          createdAt: TS,
          updatedAt: TS,
          items: [
            {
              id: 'item-a',
              shoppingListId: LIST,
              ingredientId: null,
              ingredientNameSnapshot: '鸡蛋',
              quantity: 10,
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
            },
          ],
        } as never,
      });

      const command: SyncOperation = {
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
              createdIngredient: true,
              ingredientId: 'ing-new',
              ingredientNameSnapshot: '鸡蛋',
              ingredientUnit: 'PIECE',
              ingredientQuantity: 10,
              ingredientBaseVersion: null,
              ingredientVersion: 1,
              ingredientCategory: null,
              batchId: 'batch-new',
              batchQuantity: 10,
              batchUnit: 'PIECE',
              logId: 'log-new',
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
      };

      // 云端版本已推进到 2：基于 1 的入库在服务端已过期，必须失败并回传权威状态。
      replayOperation(target.sql, {
        id: 'op-advance',
        entity: 'ShoppingList',
        entityId: LIST,
        kind: 'upsert',
        baseVersion: 1,
        payload: {
          id: LIST,
          name: '购物清单',
          status: 'ACTIVE',
          notes: null,
          version: 2,
          deletedAt: null,
          createdAt: TS,
          updatedAt: TS,
          items: [],
        } as never,
      });

      const rejection = authoritativeRejection(target.sql, command, {
        operationId: 'op-checkin',
        code: 'VERSION_CONFLICT',
        serverVersion: 2,
      });
      const units = rejection.authoritative!.map((unit) => ({
        entity: unit.entity,
        entityId: unit.entityId,
        rows: unit.rows.map((change) => `${change.table}:${String(change.id)}`),
      }));
      const list = units.find((unit) => unit.entity === 'ShoppingList');
      expect(list?.entityId).toBe(LIST);
      expect(list?.rows).toEqual(['ShoppingList:shopping_list_active_default']);
      const ingredient = units.find((unit) => unit.entity === 'Ingredient');
      // 入库食材尚未落地：单元存在但 rows 为空（本来就不存在）。
      expect(ingredient).toEqual({ entity: 'Ingredient', entityId: 'ing-new', rows: [] });
    } finally {
      target.close();
    }
  });

  it('Tag 自然键撞键：同名同类型不同 id 收敛到同一行，不产生冲突', () => {
    const target = ledger();
    try {
      replayOperation(target.sql, {
        id: 'tag-a-op',
        entity: 'Tag',
        entityId: 'tag-a',
        kind: 'upsert',
        baseVersion: null,
        payload: {
          id: 'tag-a',
          name: '快手菜',
          type: 'GENERAL',
          deletedAt: null,
          createdAt: TS,
          updatedAt: TS,
        } as never,
      });
      const merged = replayOperation(target.sql, {
        id: 'tag-b-op',
        entity: 'Tag',
        entityId: 'tag-b',
        kind: 'upsert',
        baseVersion: 1,
        payload: {
          id: 'tag-b',
          name: '快手菜',
          type: 'GENERAL',
          deletedAt: null,
          createdAt: TS,
          updatedAt: TS,
        } as never,
      });
      expect(idsOf(target, 'Tag')).toEqual(['tag-a']);
      expect(merged.changes.map((change) => `${change.table}:${String(change.id)}`)).toEqual([
        'Tag:tag-a',
      ]);
      // 权威快照对既有同键行仍是完整一行，端侧可据此对齐本地引用。
      const rejection = authoritativeRejection(
        target.sql,
        {
          id: 'tag-c-op',
          entity: 'Tag',
          entityId: 'tag-c',
          kind: 'upsert',
          baseVersion: 1,
          payload: {
            id: 'tag-c',
            name: '快手菜',
            type: 'GENERAL',
            deletedAt: null,
            createdAt: TS,
            updatedAt: TS,
          } as never,
        },
        { operationId: 'tag-c-op', code: 'VERSION_CONFLICT', serverVersion: 1 },
      );
      const tags = rejection.authoritative!.filter((unit) => unit.entity === 'Tag');
      expect(tags.map((unit) => unit.entityId).sort()).toEqual(['tag-a', 'tag-c']);
      expect(tags.find((unit) => unit.entityId === 'tag-a')?.rows[0]?.row).toMatchObject({
        id: 'tag-a',
        name: '快手菜',
      });
      expect(tags.find((unit) => unit.entityId === 'tag-c')?.rows).toEqual([]);
    } finally {
      target.close();
    }
  });

  it('INSUFFICIENT_STOCK：同时回传食材与其批次/日志', () => {
    const target = ledger();
    try {
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
          category: null,
          quantity: 2,
          unit: 'PIECE',
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
          batches: [
            {
              id: 'batch-1',
              ingredientId: 'ing-1',
              quantity: 2,
              unit: 'PIECE',
              purchaseDate: null,
              expiryDate: null,
              location: null,
              opened: false,
              consumePriority: false,
              notes: null,
              version: 1,
              deletedAt: null,
              createdAt: TS,
              updatedAt: TS,
            },
          ],
          inventoryLogs: [
            {
              id: 'log-1',
              ingredientId: 'ing-1',
              ingredientNameSnapshot: '鸡蛋',
              inventoryBatchId: null,
              beforeQuantity: 0,
              changeQuantity: 2,
              afterQuantity: 2,
              unit: 'PIECE',
              changeType: 'ADJUST',
              relatedPlanId: null,
              relatedRecordId: null,
              notes: null,
              createdAt: TS,
              updatedAt: TS,
            },
          ],
        } as never,
      });

      const command: SyncOperation = {
        id: 'op-consume',
        entity: 'Ingredient',
        entityId: 'ing-1',
        kind: 'command',
        commandType: 'INGREDIENT_CONSUME',
        baseVersion: 1,
        payloadHash: 'c'.repeat(64),
        payload: {
          id: 'ing-1',
          baseVersion: 1,
          executedAt: TS,
          request: {
            mode: 'QUANTITY',
            quantity: 5,
            unit: 'PIECE',
            ingredientVersion: 1,
            notes: null,
          },
          deductions: [
            {
              batchId: 'batch-1',
              logId: 'log-2',
              beforeQuantity: 2,
              changeQuantity: -5,
              afterQuantity: -3,
              unit: 'PIECE',
            },
          ],
          inventoryLogIds: ['log-2'],
        } as never,
      };
      const conflict = capture(() => replayOperation(target.sql, command));
      expect(conflict.rejection.code).toBe('INSUFFICIENT_STOCK');
      const rejection = authoritativeRejection(target.sql, command, conflict.rejection);
      const unit = rejection.authoritative!.find((entry) => entry.entity === 'Ingredient');
      expect(unit?.entityId).toBe('ing-1');
      expect(unit?.rows.map((change) => `${change.table}:${String(change.id)}`).sort()).toEqual([
        'Ingredient:ing-1',
        'InventoryBatch:batch-1',
        'InventoryLog:log-1',
      ]);
    } finally {
      target.close();
    }
  });
});

describe('软删级联与排餐内嵌 Diner', () => {
  it('软删 Ingredient 同步软删全部未删除批次并推进版本', () => {
    const target = ledger();
    try {
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
          category: null,
          quantity: 3,
          unit: 'PIECE',
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
          batches: [
            {
              id: 'batch-1',
              ingredientId: 'ing-1',
              quantity: 1,
              unit: 'PIECE',
              purchaseDate: null,
              expiryDate: null,
              location: null,
              opened: false,
              consumePriority: false,
              notes: null,
              version: 1,
              deletedAt: null,
              createdAt: TS,
              updatedAt: TS,
            },
            {
              id: 'batch-2',
              ingredientId: 'ing-1',
              quantity: 2,
              unit: 'PIECE',
              purchaseDate: null,
              expiryDate: null,
              location: null,
              opened: false,
              consumePriority: false,
              notes: null,
              version: 4,
              deletedAt: null,
              createdAt: TS,
              updatedAt: TS,
            },
          ],
          inventoryLogs: [],
        } as never,
      });

      const result = replayOperation(target.sql, {
        id: 'op-del',
        entity: 'Ingredient',
        entityId: 'ing-1',
        kind: 'delete',
        baseVersion: 1,
        deletedAt: '2026-11-22T00:00:00.000Z',
      });

      const batches = rowsOf(target, 'InventoryBatch');
      expect(batches).toEqual([
        expect.objectContaining({
          id: 'batch-1',
          deletedAt: '2026-11-22T00:00:00.000Z',
          version: 2,
        }),
        expect.objectContaining({
          id: 'batch-2',
          deletedAt: '2026-11-22T00:00:00.000Z',
          version: 5,
        }),
      ]);
      expect(
        result.changes
          .filter((change) => change.table === 'InventoryBatch')
          .map((change) => change.id),
      ).toEqual(['batch-1', 'batch-2']);
      expect(rowsOf(target, 'Ingredient')[0]).toMatchObject({
        deletedAt: '2026-11-22T00:00:00.000Z',
        version: 2,
      });
    } finally {
      target.close();
    }
  });

  it('排餐内嵌 diners 不覆盖已有 Diner 主表字段，也不回退 version', () => {
    const target = ledger();
    try {
      replayOperation(target.sql, {
        id: 'op-diner',
        entity: 'Diner',
        entityId: 'diner-1',
        kind: 'upsert',
        baseVersion: null,
        payload: {
          id: 'diner-1',
          name: '甲',
          avatarPath: null,
          active: true,
          likesText: '鱼',
          dislikesText: null,
          tabooText: null,
          allergyText: null,
          portionNote: null,
          notes: null,
          version: 5,
          createdAt: TS,
          updatedAt: TS,
        } as never,
      });
      replayOperation(target.sql, {
        id: 'op-plan',
        entity: 'MealPlan',
        entityId: 'plan-1',
        kind: 'upsert',
        baseVersion: null,
        payload: planPayload('plan-1', {
          diners: [
            {
              id: 'diner-1',
              name: '旧名字',
              avatarPath: null,
              active: true,
              likesText: null,
              dislikesText: null,
              tabooText: null,
              allergyText: null,
              portionNote: null,
              notes: null,
              version: 1,
              createdAt: TS,
              updatedAt: TS,
            },
          ],
        }) as never,
      });
      expect(rowsOf(target, 'Diner')[0]).toMatchObject({
        id: 'diner-1',
        name: '甲',
        likesText: '鱼',
        version: 5,
      });
      expect(idsOf(target, 'MealPlanDiner')).toEqual(['mpd:plan-1:diner-1']);
    } finally {
      target.close();
    }
  });
});

describe('权威集合外键闭包与同链副根', () => {
  function insertParentRows(target: Ledger): void {
    target.sql.exec(
      `INSERT INTO "Recipe" ("id","name","version","deletedAt","createdAt","updatedAt")
       VALUES ('recipe-peer','对端新菜谱',1,NULL,?,?)`,
      TS,
      TS,
    );
    target.sql.exec(
      `INSERT INTO "Tag" ("id","name","type","deletedAt","createdAt","updatedAt")
       VALUES ('tag-peer','家常','GENERAL',NULL,?,?)`,
      TS,
      TS,
    );
    target.sql.exec(
      `INSERT INTO "Diner" ("id","name","active","version","createdAt","updatedAt")
       VALUES ('diner-peer','对端食客',1,1,?,?)`,
      TS,
      TS,
    );
  }

  it('胜出排餐子行引用的对端新 Recipe/Diner 以 dependency 单元补齐', () => {
    const target = ledger();
    try {
      insertParentRows(target);
      replayOperation(target.sql, {
        id: 'op-a',
        entity: 'MealPlan',
        entityId: 'plan-a',
        kind: 'upsert',
        baseVersion: null,
        payload: planPayload('plan-a', {
          items: [
            {
              id: 'mpi-a',
              mealPlanId: 'plan-a',
              itemType: 'RECIPE',
              mealRole: 'MAIN',
              recipeId: 'recipe-peer',
              storeId: null,
              customName: null,
              sortOrder: 0,
              createdAt: TS,
              updatedAt: TS,
            },
          ],
          diners: [
            {
              id: 'diner-peer',
              name: '对端食客',
              avatarPath: null,
              active: true,
              likesText: null,
              dislikesText: null,
              tabooText: null,
              allergyText: null,
              portionNote: null,
              notes: null,
              version: 1,
              createdAt: TS,
              updatedAt: TS,
            },
          ],
        }) as never,
      });
      const conflict = capture(() =>
        replayOperation(target.sql, {
          id: 'op-b',
          entity: 'MealPlan',
          entityId: 'plan-b',
          kind: 'upsert',
          baseVersion: null,
          payload: planPayload('plan-b') as never,
        }),
      );
      const rejection = authoritativeRejection(
        target.sql,
        conflict.operation as SyncOperation,
        conflict.rejection,
      );
      const dependencies = (rejection.authoritative ?? []).filter((unit) => unit.dependency);
      expect(dependencies.map((unit) => `${unit.entity}:${unit.entityId}`).sort()).toEqual([
        'Diner:diner-peer',
        'Recipe:recipe-peer',
      ]);
      for (const unit of dependencies) {
        expect(unit.rows).toHaveLength(1);
        expect(unit.rows[0]?.row).not.toBeNull();
      }
      // 普通单元不受影响：仍是「被拒空根 + 胜出完整聚合」。
      const roots = (rejection.authoritative ?? []).filter((unit) => !unit.dependency);
      expect(roots).toHaveLength(2);
    } finally {
      target.close();
    }
  });

  it('同聚合根后继命令的副根（MealRecord）随权威集合回滚', () => {
    const target = ledger();
    try {
      replayOperation(target.sql, {
        id: 'op-plan',
        entity: 'MealPlan',
        entityId: 'plan-chain',
        kind: 'upsert',
        baseVersion: null,
        payload: planPayload('plan-chain', { status: 'COMPLETED', version: 2 }) as never,
      });
      target.sql.exec(
        `INSERT INTO "MealRecord"
           ("id","recordDate","mealType","sourceType","status","sourceMealPlanId","version","deletedAt","createdAt","updatedAt")
         VALUES ('record-chain','2026-11-21','DINNER','PLAN','DRAFT','plan-chain',3,NULL,?,?)`,
        TS,
        TS,
      );
      const operation: SyncOperation = {
        id: 'op-chain-1',
        entity: 'MealPlan',
        entityId: 'plan-chain',
        kind: 'upsert',
        baseVersion: 1,
        payload: planPayload('plan-chain') as never,
      };
      const successor: SyncOperation = {
        id: 'op-chain-2',
        entity: 'MealPlan',
        entityId: 'plan-chain',
        kind: 'command',
        commandType: 'PLAN_COMPLETE',
        baseVersion: 2,
        payload: { record: { id: 'record-chain' }, recordRevived: true },
        payloadHash: 'a'.repeat(64),
      };
      const rejection = authoritativeRejection(
        target.sql,
        operation,
        { operationId: operation.id, code: 'VERSION_CONFLICT', serverVersion: 2 },
        [successor],
      );
      const record = (rejection.authoritative ?? []).find(
        (unit) =>
          !unit.dependency && unit.entity === 'MealRecord' && unit.entityId === 'record-chain',
      );
      expect(record?.rows.map((change) => `${change.table}:${String(change.id)}`)).toEqual([
        'MealRecord:record-chain',
      ]);
      expect((record?.rows[0]?.row as Record<string, unknown>).deletedAt).toBeNull();
    } finally {
      target.close();
    }
  });
});
