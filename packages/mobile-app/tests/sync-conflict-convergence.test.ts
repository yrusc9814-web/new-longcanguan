import { describe, expect, it } from 'vitest';

import { openDatabase, type DatabaseHandle } from '../src/db/database.js';
import {
  applyRowChanges,
  createColumnCache,
  pendingOutbox,
  readTableRows,
  writeSyncState,
} from '../src/sync/ledger.js';
import { alignConflictedEntities, convergePushConflicts, pullUntilIdle } from '../src/sync/pull.js';
import { pushOutbox, type PushConflict } from '../src/sync/push.js';
import { createSyncHttpClient, type SyncHttpContext, type SyncFetch } from '../src/sync/http.js';
import { createSyncEngine } from '../src/sync/engine.js';
import { createMemoryAppSecurity } from '../src/native/app-security.js';
import { createMemoryUploadsFiles } from '../src/native/upload-files.js';
import { createNodeSqliteDriver } from './helpers/node-sqlite-driver.js';

const NOW = new Date('2026-11-23T00:00:00.000Z');
const EPOCH = 1;
const STAMP = NOW.toISOString();

async function db(): Promise<DatabaseHandle> {
  const handle = await openDatabase({
    driver: createNodeSqliteDriver({ path: ':memory:' }),
    now: () => NOW,
  });
  await handle.setEpoch(EPOCH);
  return handle;
}

function context(): SyncHttpContext {
  return {
    cloudOrigin: 'https://cloud.example',
    householdId: 'hh',
    memberId: 'm1',
    role: 'MEMBER',
    generation: 1,
    epoch: EPOCH,
    token: 'tok',
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function http(fetchImpl: SyncFetch) {
  return createSyncHttpClient({ fetch: fetchImpl, context: async () => context() });
}

async function applyRows(database: DatabaseHandle, changes: Parameters<typeof applyRowChanges>[2]) {
  const cache = createColumnCache();
  await database.withWriteTransaction(async (tx) => {
    await applyRowChanges(tx, cache, changes);
  });
}

describe('ledger：自然唯一键对齐', () => {
  it('双端离线同名 Tag：云端胜出 ID 落地，本地 RecipeTag 引用整体迁移且不撞唯一索引', async () => {
    const database = await db();
    await database.withWriteTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO "Recipe" ("id","name","version","updatedAt") VALUES ('r1','番茄炒蛋',1,?)`,
        [STAMP],
      );
      await tx.run(
        `INSERT INTO "Tag" ("id","name","type","createdAt","updatedAt") VALUES ('tag-local','家常','GENERAL',?,?)`,
        [STAMP, STAMP],
      );
      await tx.run(
        `INSERT INTO "RecipeTag" ("id","recipeId","tagId","createdAt","updatedAt") VALUES ('rt-local','r1','tag-local',?,?)`,
        [STAMP, STAMP],
      );
    });

    await applyRows(database, [
      {
        table: 'Tag',
        id: 'tag-cloud',
        row: {
          id: 'tag-cloud',
          name: '家常',
          type: 'GENERAL',
          deletedAt: null,
          createdAt: STAMP,
          updatedAt: STAMP,
        },
      },
      {
        table: 'RecipeTag',
        id: 'rt-cloud',
        row: {
          id: 'rt-cloud',
          recipeId: 'r1',
          tagId: 'tag-cloud',
          createdAt: STAMP,
          updatedAt: STAMP,
        },
      },
    ]);

    expect(await readTableRows(database, 'Tag')).toMatchObject([{ id: 'tag-cloud', name: '家常' }]);
    expect(await readTableRows(database, 'RecipeTag')).toMatchObject([
      { id: 'rt-cloud', recipeId: 'r1', tagId: 'tag-cloud' },
    ]);
  });

  it('复合唯一键（RecipeStep recipeId+stepNo）主键不同时先剪本地旧行', async () => {
    const database = await db();
    await database.withWriteTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO "Recipe" ("id","name","version","updatedAt") VALUES ('r1','汤',1,?)`,
        [STAMP],
      );
      await tx.run(
        `INSERT INTO "RecipeStep" ("id","recipeId","stepNo","content","createdAt","updatedAt") VALUES ('step-local','r1',1,'旧',?,?)`,
        [STAMP, STAMP],
      );
    });

    await applyRows(database, [
      {
        table: 'RecipeStep',
        id: 'step-cloud',
        row: {
          id: 'step-cloud',
          recipeId: 'r1',
          stepNo: 1,
          content: '新',
          createdAt: STAMP,
          updatedAt: STAMP,
        },
      },
    ]);

    expect(await readTableRows(database, 'RecipeStep')).toMatchObject([
      { id: 'step-cloud', recipeId: 'r1', stepNo: 1, content: '新' },
    ]);
  });

  it('排餐槽位：云端权威行占位时本地新建让位并丢弃其操作链，本地既有排餐不被误删', async () => {
    const database = await db();
    await database.withWriteTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO "MealPlan" ("id","planDate","mealType","version","updatedAt") VALUES ('plan-new','2026-12-01','DINNER',1,?)`,
        [STAMP],
      );
      await tx.run(
        `INSERT INTO "MealPlanItem" ("id","mealPlanId","itemType","sortOrder","updatedAt") VALUES ('item-new','plan-new','CUSTOM',0,?)`,
        [STAMP],
      );
      await tx.enqueue({
        opId: 'op-new',
        entity: 'MealPlan',
        entityId: 'plan-new',
        kind: 'upsert',
        baseVersion: null,
        payload: { id: 'plan-new' },
      });
      // 已同步排餐（另一槽位）：不是本次让位对象，必须保留。
      await tx.run(
        `INSERT INTO "MealPlan" ("id","planDate","mealType","version","updatedAt") VALUES ('plan-moved','2026-12-02','DINNER',3,?)`,
        [STAMP],
      );
      await tx.enqueue({
        opId: 'op-moved',
        entity: 'MealPlan',
        entityId: 'plan-moved',
        kind: 'upsert',
        baseVersion: 2,
        payload: { id: 'plan-moved' },
      });
    });

    await applyRows(database, [
      {
        table: 'MealPlan',
        id: 'plan-winner',
        row: {
          id: 'plan-winner',
          planDate: '2026-12-01',
          mealType: 'DINNER',
          version: 1,
          deletedAt: null,
          createdAt: STAMP,
          updatedAt: STAMP,
        },
      },
    ]);

    const plans = await readTableRows(database, 'MealPlan');
    expect(plans.map((row) => row.id)).toEqual(['plan-moved', 'plan-winner']);
    expect(await readTableRows(database, 'MealPlanItem')).toHaveLength(0);
    expect((await pendingOutbox(database, EPOCH, 10)).map((row) => row.opId)).toEqual(['op-moved']);
  });

  it('排餐槽位：已同步排餐改期撞槽时保留本地行，不套用权威行', async () => {
    const database = await db();
    await database.withWriteTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO "MealPlan" ("id","planDate","mealType","version","updatedAt") VALUES ('plan-moved','2026-12-01','DINNER',3,?)`,
        [STAMP],
      );
      await tx.enqueue({
        opId: 'op-moved',
        entity: 'MealPlan',
        entityId: 'plan-moved',
        kind: 'upsert',
        baseVersion: 2,
        payload: { id: 'plan-moved' },
      });
    });

    await applyRows(database, [
      {
        table: 'MealPlan',
        id: 'plan-winner',
        row: {
          id: 'plan-winner',
          planDate: '2026-12-01',
          mealType: 'DINNER',
          version: 1,
          deletedAt: null,
          createdAt: STAMP,
          updatedAt: STAMP,
        },
      },
    ]);

    expect((await readTableRows(database, 'MealPlan')).map((row) => row.id)).toEqual([
      'plan-moved',
    ]);
    expect((await pendingOutbox(database, EPOCH, 10)).map((row) => row.opId)).toEqual(['op-moved']);
  });
});

describe('conflict：整链回滚与权威集合', () => {
  async function seedCheckin(database: DatabaseHandle): Promise<void> {
    await database.withWriteTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO "ShoppingList" ("id","name","status","version","updatedAt") VALUES ('list-1','购物清单','ACTIVE',3,?)`,
        [STAMP],
      );
      await tx.run(
        `INSERT INTO "ShoppingListItem" ("id","shoppingListId","ingredientNameSnapshot","sourceType","completed","sortOrder","createdAt","updatedAt")
         VALUES ('item-keep','list-1','牛奶','MANUAL',0,0,?,?)`,
        [STAMP, STAMP],
      );
      await tx.run(
        `INSERT INTO "Ingredient" ("id","name","quantity","unit","version","createdAt","updatedAt")
         VALUES ('ing-new','鸡蛋',6,'PIECE',1,?,?)`,
        [STAMP, STAMP],
      );
      await tx.run(
        `INSERT INTO "InventoryBatch" ("id","ingredientId","quantity","unit","version","createdAt","updatedAt")
         VALUES ('batch-new','ing-new',6,'PIECE',1,?,?)`,
        [STAMP, STAMP],
      );
      await tx.run(
        `INSERT INTO "InventoryLog" ("id","ingredientId","ingredientNameSnapshot","inventoryBatchId",
           "beforeQuantity","changeQuantity","afterQuantity","unit","changeType","createdAt","updatedAt")
         VALUES ('log-new','ing-new','鸡蛋','batch-new',0,6,6,'PIECE','PURCHASE',?,?)`,
        [STAMP, STAMP],
      );
      await tx.run(
        `INSERT INTO "ShoppingCheckinOperation" ("id","shoppingListId","payloadHash","resultJson","createdAt")
         VALUES ('checkin-op','list-1','h','{}',?)`,
        [STAMP],
      );
      await tx.enqueue({
        opId: 'op-checkin',
        entity: 'ShoppingList',
        entityId: 'list-1',
        kind: 'command',
        commandType: 'SHOPPING_CHECKIN',
        baseVersion: 3,
        payload: {
          shoppingListId: 'list-1',
          baseVersion: 3,
          executedAt: STAMP,
          listVersion: 4,
          purchaseDate: '2026-11-23',
          request: {
            shoppingListId: 'list-1',
            baseVersion: 3,
            operationId: 'checkin-op',
            itemIds: ['item-gone'],
          },
          items: [
            {
              id: 'item-gone',
              ingredientId: null,
              ingredientNameSnapshot: '鸡蛋',
              quantity: 6,
              unit: 'PIECE',
              amountText: null,
              category: null,
              sourceType: 'MANUAL',
              sourceId: null,
              completed: false,
              sortOrder: 1,
              notes: null,
              createdAt: STAMP,
              updatedAt: STAMP,
            },
          ],
          inventory: [
            {
              kind: 'INGREDIENT_IMPORT',
              createdIngredient: true,
              ingredientId: 'ing-new',
              ingredientNameSnapshot: '鸡蛋',
              ingredientUnit: 'PIECE',
              ingredientQuantity: 6,
              ingredientBaseVersion: null,
              ingredientVersion: 1,
              ingredientCategory: null,
              batchId: 'batch-new',
              batchQuantity: 6,
              batchUnit: 'PIECE',
              logId: 'log-new',
              beforeQuantity: 0,
              afterQuantity: 6,
              executedAt: STAMP,
            },
          ],
          operation: {
            id: 'checkin-op',
            shoppingListId: 'list-1',
            payloadHash: 'h',
            resultJson: '{}',
            createdAt: STAMP,
          },
        },
      });
      await tx.run(`UPDATE "ShoppingList" SET "version" = 4 WHERE "id" = 'list-1'`);
      await tx.run(`DELETE FROM "ShoppingListItem" WHERE "id" = 'item-gone'`);
    });
  }

  function checkinConflict(): PushConflict {
    return {
      opId: 'op-checkin',
      entity: 'ShoppingList',
      entityId: 'list-1',
      code: 'VERSION_CONFLICT',
      serverVersion: 5,
      ingredientId: null,
      winner: null,
      payload: null,
      chain: [
        {
          opId: 'op-checkin',
          entity: 'ShoppingList',
          entityId: 'list-1',
          kind: 'command',
          commandType: 'SHOPPING_CHECKIN',
          baseVersion: 3,
          payloadJson: JSON.stringify({
            inventory: [
              {
                createdIngredient: true,
                ingredientId: 'ing-new',
                batchId: 'batch-new',
                logId: 'log-new',
              },
            ],
            items: [
              {
                id: 'item-gone',
                shoppingListId: 'list-1',
                ingredientId: null,
                ingredientNameSnapshot: '鸡蛋',
                quantity: 6,
                unit: 'PIECE',
                amountText: null,
                category: null,
                sourceType: 'MANUAL',
                sourceId: null,
                completed: 0,
                sortOrder: 1,
                notes: null,
                createdAt: STAMP,
                updatedAt: STAMP,
              },
            ],
            operation: { id: 'checkin-op' },
          }),
        },
      ],
      authoritative: [],
    };
  }

  it('被拒 SHOPPING_CHECKIN：新建食材/批次/日志与幂等行一并回滚，条目按载荷原样放回', async () => {
    const database = await db();
    await seedCheckin(database);
    const outcomes = await convergePushConflicts(database, [checkinConflict()]);

    expect(outcomes.get('op-checkin')).toMatchObject({
      ingredientRolledBack: true,
      authoritative: false,
    });
    expect(await readTableRows(database, 'Ingredient')).toHaveLength(0);
    expect(await readTableRows(database, 'InventoryBatch')).toHaveLength(0);
    expect(await readTableRows(database, 'InventoryLog')).toHaveLength(0);
    expect(await readTableRows(database, 'ShoppingCheckinOperation')).toHaveLength(0);
    expect((await readTableRows(database, 'ShoppingListItem')).map((row) => row.id).sort()).toEqual(
      ['item-gone', 'item-keep'],
    );
    // 发件箱链的删除由 push 的拒绝分支完成；这里只验证副作用回滚。
    expect((await pendingOutbox(database, EPOCH, 10)).map((row) => row.opId)).toEqual([
      'op-checkin',
    ]);
  });

  it('被拒 RECORD_DELETE：本地软删与来源计划回退一并撤销', async () => {
    const database = await db();
    await database.withWriteTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO "MealPlan" ("id","planDate","mealType","version","status","completedAt","updatedAt")
         VALUES ('p1','2026-12-05','LUNCH',2,'PLANNED',?,?)`,
        [STAMP, STAMP],
      );
      await tx.run(
        `INSERT INTO "MealRecord" ("id","recordDate","mealType","sourceType","status","sourceMealPlanId","version","deletedAt","updatedAt")
         VALUES ('rec','2026-12-05','LUNCH','PLAN','DRAFT','p1',3,?,?)`,
        [STAMP, STAMP],
      );
      await tx.enqueue({
        opId: 'op-delete',
        entity: 'MealRecord',
        entityId: 'rec',
        kind: 'command',
        commandType: 'RECORD_DELETE',
        baseVersion: 2,
        payload: {
          id: 'rec',
          baseVersion: 2,
          executedAt: STAMP,
          deletedAt: STAMP,
          releasedSourceMealPlanId: 'p1',
          revertedPlan: { id: 'p1', version: 2, status: 'PLANNED', completedAt: STAMP },
        },
      });
    });

    await convergePushConflicts(database, [
      {
        opId: 'op-delete',
        entity: 'MealRecord',
        entityId: 'rec',
        code: 'VERSION_CONFLICT',
        serverVersion: 4,
        ingredientId: null,
        winner: null,
        payload: null,
        chain: [
          {
            opId: 'op-delete',
            entity: 'MealRecord',
            entityId: 'rec',
            kind: 'command',
            commandType: 'RECORD_DELETE',
            baseVersion: 2,
            payloadJson: JSON.stringify({
              id: 'rec',
              executedAt: STAMP,
              releasedSourceMealPlanId: 'p1',
              revertedPlan: { id: 'p1', version: 2 },
            }),
          },
        ],
        authoritative: [],
      },
    ]);

    expect(await readTableRows(database, 'MealRecord')).toMatchObject([
      { id: 'rec', deletedAt: null, sourceMealPlanId: 'p1' },
    ]);
    expect(await readTableRows(database, 'MealPlan')).toMatchObject([
      { id: 'p1', status: 'COMPLETED', version: 1 },
    ]);
  });

  it('云端给出权威聚合行时，本地父子表被完整替换（含多出来的子行剪除）', async () => {
    const database = await db();
    await seedCheckin(database);
    const conflict = checkinConflict();
    const withAuthoritative: PushConflict = {
      ...conflict,
      authoritative: [
        {
          entity: 'ShoppingList',
          entityId: 'list-1',
          dependency: false,
          rows: [
            {
              table: 'ShoppingList',
              id: 'list-1',
              row: {
                id: 'list-1',
                name: '购物清单',
                status: 'ACTIVE',
                notes: null,
                version: 5,
                deletedAt: null,
                createdAt: STAMP,
                updatedAt: STAMP,
              },
            },
            {
              table: 'ShoppingListItem',
              id: 'item-cloud',
              row: {
                id: 'item-cloud',
                shoppingListId: 'list-1',
                ingredientId: null,
                ingredientNameSnapshot: '服务端牛奶',
                quantity: null,
                unit: null,
                amountText: null,
                category: null,
                sourceType: 'MANUAL',
                sourceId: null,
                completed: 0,
                sortOrder: 0,
                notes: null,
                createdAt: STAMP,
                updatedAt: STAMP,
              },
            },
          ],
        },
      ],
    };

    const outcomes = await convergePushConflicts(database, [withAuthoritative]);

    expect(outcomes.get('op-checkin')?.authoritative).toBe(true);
    expect(await readTableRows(database, 'ShoppingList')).toMatchObject([
      { id: 'list-1', version: 5 },
    ]);
    expect((await readTableRows(database, 'ShoppingListItem')).map((row) => row.id)).toEqual([
      'item-cloud',
    ]);
    expect(await readTableRows(database, 'Ingredient')).toHaveLength(0);
  });

  it('push 解析拒绝响应中的 authoritative 与整条操作链', async () => {
    const database = await db();
    await database.withWriteTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO "Recipe" ("id","name","version","updatedAt") VALUES ('r1','菜',2,?)`,
        [STAMP],
      );
      await tx.enqueue({
        opId: 'op-1',
        entity: 'Recipe',
        entityId: 'r1',
        kind: 'upsert',
        baseVersion: 1,
        payload: { id: 'r1', name: '本地名', version: 2 },
      });
      await tx.enqueue({
        opId: 'op-2',
        entity: 'Recipe',
        entityId: 'r1',
        kind: 'upsert',
        baseVersion: 2,
        payload: { id: 'r1', name: '本地名2', version: 3 },
      });
    });
    const client = http(async () =>
      json(409, {
        acceptedOperationIds: [],
        acknowledgements: [],
        rejected: [
          {
            operationId: 'op-1',
            code: 'VERSION_CONFLICT',
            serverVersion: 3,
            authoritative: [
              {
                entity: 'Recipe',
                entityId: 'r1',
                rows: [
                  {
                    table: 'Recipe',
                    id: 'r1',
                    row: {
                      id: 'r1',
                      name: '云端名',
                      version: 3,
                      deletedAt: null,
                      updatedAt: NOW.toISOString(),
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const result = await pushOutbox({ database, http: client, clientId: 'd', epoch: EPOCH });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.chain.map((row) => row.opId)).toEqual(['op-1', 'op-2']);
    expect(result.conflicts[0]!.authoritative).toMatchObject([
      { entity: 'Recipe', entityId: 'r1', rows: [{ table: 'Recipe', id: 'r1' }] },
    ]);
    expect(await pendingOutbox(database, EPOCH, 10)).toHaveLength(0);
  });
});

describe('pull：聚合父子同进退', () => {
  it('父行有未确认操作时，其子表行一并跳过；无关实体照常落地', async () => {
    const database = await db();
    await database.withWriteTransaction(async (tx) => {
      await tx.enqueue({
        opId: 'op-plan',
        entity: 'MealPlan',
        entityId: 'p1',
        kind: 'upsert',
        baseVersion: null,
        payload: { id: 'p1' },
      });
    });
    const client = http(async () =>
      json(200, {
        epoch: EPOCH,
        entries: [
          {
            seq: 7,
            operationId: 'remote',
            changes: [
              {
                table: 'MealPlanItem',
                id: 'i1',
                row: {
                  id: 'i1',
                  mealPlanId: 'p1',
                  itemType: 'CUSTOM',
                  sortOrder: 0,
                  updatedAt: STAMP,
                },
              },
              {
                table: 'Diner',
                id: 'd1',
                row: { id: 'd1', name: '小明', version: 1, updatedAt: STAMP },
              },
            ],
          },
        ],
        nextSeq: 7,
        hasMore: false,
      }),
    );
    const result = await pullUntilIdle({ database, http: client, epoch: EPOCH });
    expect(result.skipped).toEqual(['MealPlanItem:i1']);
    expect(await readTableRows(database, 'MealPlanItem')).toHaveLength(0);
    expect(await readTableRows(database, 'Diner')).toMatchObject([{ id: 'd1' }]);
  });

  it('强制对齐（forceKeys）时不再受本地未确认保护', async () => {
    const database = await db();
    await database.withWriteTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO "Recipe" ("id","name","version","updatedAt") VALUES ('r1','本地',1,?)`,
        [STAMP],
      );
      await tx.enqueue({
        opId: 'op-1',
        entity: 'Recipe',
        entityId: 'r1',
        kind: 'upsert',
        baseVersion: 1,
        payload: { id: 'r1', name: '本地', version: 2 },
      });
    });
    const client = http(async () =>
      json(200, {
        epoch: EPOCH,
        entries: [
          {
            seq: 3,
            operationId: 'remote',
            changes: [
              {
                table: 'Recipe',
                id: 'r1',
                row: { id: 'r1', name: '云端', version: 3, deletedAt: null, updatedAt: STAMP },
              },
            ],
          },
        ],
        nextSeq: 3,
        hasMore: false,
      }),
    );
    const conflict: PushConflict = {
      opId: 'op-1',
      entity: 'Recipe',
      entityId: 'r1',
      code: 'VERSION_CONFLICT',
      serverVersion: 3,
      ingredientId: null,
      winner: null,
      payload: null,
      chain: [],
      authoritative: [],
    };
    await alignConflictedEntities({ database, http: client, epoch: EPOCH }, [conflict]);
    expect(await readTableRows(database, 'Recipe')).toMatchObject([{ name: '云端', version: 3 }]);
  });
});

describe('engine：冲突后继续推空发件箱', () => {
  it('同批前序被回滚导致 unresolved>0 时，收敛后继续推送并最终 ok', async () => {
    const database = await db();
    await database.withWriteTransaction(async (tx) => {
      await tx.run(
        `UPDATE "device_local_config"
            SET "cloudOrigin" = 'https://cloud.example', "householdId" = 'hh',
                "memberId" = 'm1', "role" = 'MEMBER' WHERE "id" = 1`,
      );
      await tx.run(
        `INSERT INTO "Recipe" ("id","name","version","updatedAt") VALUES ('r1','菜',2,?)`,
        [STAMP],
      );
      await tx.enqueue({
        opId: 'op-1',
        entity: 'Recipe',
        entityId: 'r1',
        kind: 'upsert',
        baseVersion: 1,
        payload: { id: 'r1', name: '本地', version: 2 },
      });
      await tx.enqueue({
        opId: 'op-2',
        entity: 'Recipe',
        entityId: 'r1',
        kind: 'upsert',
        baseVersion: 2,
        payload: { id: 'r1', name: '本地2', version: 3 },
      });
      // 不同实体：服务端未 ack 也未拒绝（同批事务回滚），必须继续推送。
      await tx.run(
        `INSERT INTO "Diner" ("id","name","version","updatedAt") VALUES ('d1','小明',1,?)`,
        [STAMP],
      );
      await tx.enqueue({
        opId: 'op-x',
        entity: 'Diner',
        entityId: 'd1',
        kind: 'upsert',
        baseVersion: null,
        payload: { id: 'd1', name: '小明', version: 1 },
      });
    });
    const pushes: string[][] = [];
    let pushRound = 0;
    const fetch: SyncFetch = async (input, init) => {
      const url = new URL(input);
      if (url.pathname === '/api/sync/ws-ticket') return json(401, { code: 'UNAUTHORIZED' });
      if (url.pathname === '/api/sync/push') {
        const body = JSON.parse(String(init?.body)) as { operations: { id: string }[] };
        pushes.push(body.operations.map((operation) => operation.id));
        pushRound += 1;
        if (pushRound === 1) {
          return json(409, {
            acceptedOperationIds: [],
            acknowledgements: [],
            rejected: [{ operationId: 'op-1', code: 'VERSION_CONFLICT', serverVersion: 3 }],
          });
        }
        return json(200, {
          acceptedOperationIds: body.operations.map((operation) => operation.id),
          acknowledgements: [],
          rejected: [],
        });
      }
      return json(200, { epoch: EPOCH, entries: [], nextSeq: 1, hasMore: false });
    };
    const security = createMemoryAppSecurity(() => NOW.getTime());
    await security.setMemberToken({ memberToken: 'tok' });
    const engine = createSyncEngine({
      getDatabase: async () => database,
      security,
      fetch,
      files: createMemoryUploadsFiles(),
      now: () => NOW,
      timers: { setTimeout: () => 1, clearTimeout: () => undefined },
      socketFactory: () => ({
        readyState: 0,
        onmessage: null,
        onclose: null,
        onerror: null,
        send: () => undefined,
        close: () => undefined,
      }),
      deviceId: () => 'device-test',
    });

    await engine.syncOnce();

    const status = await engine.status();
    expect(pushes[0], JSON.stringify(status)).toEqual(['op-1', 'op-2', 'op-x']);
    // op-2 是被拒操作的链条后继，收敛时一并丢弃；只剩无冲突的 op-x。
    expect(pushes[1], JSON.stringify(status)).toEqual(['op-x']);
    expect(await pendingOutbox(database, EPOCH, 10)).toHaveLength(0);
    expect((await engine.status()).phase).toBe('ok');
    engine.stop();
  });
});

describe('sync-cache：编辑弹窗期间推迟缓存重载', () => {
  it('表单打开时只记待刷，关闭后统一 reload 并刷新首页', async () => {
    const { installSyncCacheRefresh } = await import('../src/local-api/sync-cache.js');
    const reloads: string[] = [];
    const emitted: string[] = [];
    let modal: { name: string }[] = [];
    const listeners: ((event: Event) => void)[] = [];
    const observers: { callback: () => void }[] = [];
    const originalObserver = globalThis.MutationObserver;
    class FakeObserver {
      constructor(private readonly callback: () => void) {
        observers.push({ callback });
      }
      observe() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    }
    (globalThis as { MutationObserver?: unknown }).MutationObserver = FakeObserver;
    try {
      const service = Object.fromEntries(
        ['stores', 'recipes', 'pantry', 'shopping', 'plans', 'records', 'tools'].map((name) => [
          name,
          {
            async reload() {
              reloads.push(name);
            },
          },
        ]),
      );
      const win = {
        document: { documentElement: {} },
        addEventListener: (_type: string, listener: (event: Event) => void) => {
          listeners.push(listener);
        },
        BentoService: service,
        BentoBus: { emit: (event: string) => emitted.push(event) },
        get BentoModal() {
          return { modalStack: modal };
        },
      };
      installSyncCacheRefresh(win as never);
      const emit = (detail: unknown) => {
        for (const listener of listeners) {
          listener(new CustomEvent('dafan:sync:state', { detail }) as never);
        }
      };

      modal = [{ name: 'pantryForm' }];
      emit({ phase: 'ok', bound: true, epoch: 1, lastSeq: 5 });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(reloads).toEqual([]);
      expect(emitted).toEqual([]);

      modal = [];
      for (const observer of observers) observer.callback();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(reloads.sort()).toEqual([
        'pantry',
        'plans',
        'recipes',
        'records',
        'shopping',
        'stores',
        'tools',
      ]);
      expect(emitted).toEqual(['dashboard:dirty']);
    } finally {
      (globalThis as { MutationObserver?: unknown }).MutationObserver = originalObserver;
    }
  });
});

describe('writeSyncState 边界', () => {
  it('游标写入后可读回', async () => {
    const database = await db();
    await database.withWriteTransaction(async (tx) => {
      await writeSyncState(tx, EPOCH, 9);
    });
    const [row] = await database.query<{ last_sync_seq: string }>(
      'SELECT "last_sync_seq" FROM "sync_state" WHERE "id" = 1',
    );
    expect(row?.last_sync_seq).toBe('9');
  });
});
