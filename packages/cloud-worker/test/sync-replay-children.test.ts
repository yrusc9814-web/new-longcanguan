import { describe, expect, it } from 'vitest';

import type { SyncEntityName, SyncOperation } from '@dafan/shared/sync';

import type { DatabaseHandle } from '../../mobile-app/src/db/database.js';
import { createDiner } from '../../mobile-app/src/modules/diners/service.js';
import {
  completePlan,
  createPlan,
  updatePlan,
} from '../../mobile-app/src/modules/meal-plans/service.js';
import { createRecord } from '../../mobile-app/src/modules/meal-records/service.js';
import {
  addShoppingItem,
  listShoppingLists,
} from '../../mobile-app/src/modules/shopping/service.js';
import { createStore, updateStore } from '../../mobile-app/src/modules/stores/service.js';
import { REPLAY_TABLES } from '../src/sync-replay-tables';
import { clearReplayHistory, replayOperation } from '../src/sync-replay';
import { ledger, mobile, outbox, toOperation, type Ledger } from './sync-replay-helpers';

/**
 * 关联子表（MealPlanDiner / MealRecordDiner / StoreMealType）的行 ID 必须在
 * 端侧与云端一致：载荷只带关联实体，云端按 `(父行, 关联值)` 派生。
 */

const NOW = new Date('2026-11-21T08:00:00.000Z');
const TS = NOW.toISOString();

let counter = 0;
function seqId(): string {
  counter += 1;
  return `id${String(counter).padStart(4, '0')}`;
}

async function diner(db: DatabaseHandle, name: string): Promise<string> {
  const created = await createDiner(db, { name }, NOW);
  return created.id;
}

function rowsOf(target: Ledger, table: SyncEntityName): Record<string, unknown>[] {
  return target.sql.exec(`SELECT * FROM "${table}" ORDER BY "id"`).toArray() as unknown as Record<
    string,
    unknown
  >[];
}

function idColumn(target: Ledger, table: SyncEntityName): string[] {
  return rowsOf(target, table).map((row) => String(row.id));
}

function count(target: Ledger, table: string): number {
  return target.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM "${table}"`).one().count;
}

function replay(target: Ledger, operation: SyncOperation): void {
  replayOperation(target.sql, operation);
}

async function syncAll(target: Ledger, db: DatabaseHandle): Promise<SyncOperation[]> {
  const operations = (await outbox(db)).map(toOperation);
  for (const operation of operations) replay(target, operation);
  return operations;
}

function planPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'plan-1',
    planDate: '2026-11-21',
    mealType: 'DINNER',
    dinerCount: 2,
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

function dinerDto(id: string): Record<string, unknown> {
  return {
    id,
    name: `diner-${id}`,
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
  };
}

describe('端侧普通操作：关联子表行 ID 与云端一致', () => {
  it('MealPlanDiner：创建与改人就餐人都复用确定性行 ID，逐列一致', async () => {
    const db = await mobile();
    const target = ledger();
    try {
      const a = await diner(db, '甲');
      const b = await diner(db, '乙');
      const c = await diner(db, '丙');

      const plan = await createPlan(
        { database: db, now: () => NOW, newId: seqId },
        {
          planDate: '2026-11-21',
          mealType: 'DINNER',
          dinerCount: 2,
          status: 'PLANNED',
          notes: null,
          time: null,
          title: null,
          subtext: null,
          icon: null,
          items: [],
          dinerIds: [a, b],
        },
      );
      await syncAll(target, db);

      const expected = [`mpd:${plan.id}:${a}`, `mpd:${plan.id}:${b}`].sort();
      expect(idColumn(target, 'MealPlanDiner')).toEqual(expected);
      expect(idColumn(target, 'MealPlanDiner')).toEqual(
        (await db.query<{ id: string }>('SELECT "id" FROM "MealPlanDiner" ORDER BY "id"')).map(
          (row) => row.id,
        ),
      );
      expect(rowsOf(target, 'MealPlanDiner')).toHaveLength(2);

      await updatePlan({ database: db, now: () => NOW, newId: seqId }, plan.id, 1, {
        dinerIds: [b, c],
      });
      await syncAll(target, db);

      expect(idColumn(target, 'MealPlanDiner')).toEqual(
        [`mpd:${plan.id}:${b}`, `mpd:${plan.id}:${c}`].sort(),
      );
      expect(
        await db.query<{ id: string }>('SELECT "id" FROM "MealPlanDiner" ORDER BY "id"'),
      ).toEqual(idColumn(target, 'MealPlanDiner').map((id) => ({ id })));
    } finally {
      db.close();
      target.close();
    }
  });

  it('MealRecordDiner：记录创建与改就餐人都复用确定性行 ID', async () => {
    const db = await mobile();
    const target = ledger();
    try {
      const a = await diner(db, '甲');
      const b = await diner(db, '乙');
      const record = await createRecord(
        { database: db, now: () => NOW, newId: seqId },
        {
          recordDate: '2026-11-21',
          recordTime: null,
          title: null,
          mealType: 'DINNER',
          sourceType: 'HOMEMADE',
          status: 'CONFIRMED',
          imagePath: null,
          photos: null,
          rating: null,
          satiety: null,
          calories: null,
          cost: null,
          isNewTry: false,
          favorite: false,
          notes: null,
          relatedPlanId: null,
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
          dinerIds: [a, b],
        },
      );
      const operations = await syncAll(target, db);

      expect(idColumn(target, 'MealRecordDiner')).toEqual(
        [`mrd:${record.id}:${a}`, `mrd:${record.id}:${b}`].sort(),
      );
      expect(
        await db.query<{ id: string }>('SELECT "id" FROM "MealRecordDiner" ORDER BY "id"'),
      ).toEqual(idColumn(target, 'MealRecordDiner').map((id) => ({ id })));
      // 载荷里没有行 ID，只有 DinerDto；云端仍必须复算出同一主键。
      const upsert = operations.find(
        (operation) => operation.kind === 'upsert' && operation.entity === 'MealRecord',
      );
      expect(upsert && upsert.kind === 'upsert' ? upsert.payload.diners : null).toHaveLength(2);
    } finally {
      db.close();
      target.close();
    }
  });

  it('StoreMealType：整组替换复用确定性行 ID，改餐次不残留旧行', async () => {
    const db = await mobile();
    const target = ledger();
    try {
      const store = await createStore(db, { name: '小馆', mealTypes: ['DINNER', 'LUNCH'] }, NOW);
      await syncAll(target, db);
      expect(idColumn(target, 'StoreMealType')).toEqual(
        [`smt:${store.id}:DINNER`, `smt:${store.id}:LUNCH`].sort(),
      );

      await updateStore(db, store.id, { mealTypes: ['BREAKFAST'] }, store.version, NOW);
      await syncAll(target, db);

      expect(idColumn(target, 'StoreMealType')).toEqual([`smt:${store.id}:BREAKFAST`]);
      expect(
        await db.query<{ id: string }>('SELECT "id" FROM "StoreMealType" ORDER BY "id"'),
      ).toEqual(idColumn(target, 'StoreMealType').map((id) => ({ id })));
    } finally {
      db.close();
      target.close();
    }
  });
});

describe('旧载荷兼容', () => {
  it('旧 PLAN_COMPLETE 载荷缺 dinerRowIds：按记录自然键补齐，不丢就餐人', async () => {
    const db = await mobile();
    const target = ledger();
    try {
      const a = await diner(db, '甲');
      const plan = await createPlan(
        { database: db, now: () => NOW, newId: seqId },
        {
          planDate: '2026-11-21',
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
              customName: '番茄炒蛋',
              sortOrder: 0,
            },
          ],
          dinerIds: [a],
        },
      );
      await completePlan({ database: db, now: () => NOW, newId: seqId }, plan.id, 1);

      // 先只重放计划 upsert 建立父行，再重放「去掉 dinerRowIds」的旧命令载荷。
      const operations = (await outbox(db)).map(toOperation);
      const upsert = operations.find(
        (operation) => operation.kind === 'upsert' && operation.entity === 'MealPlan',
      )!;
      replay(target, upsert);
      const command = operations.find(
        (operation) => operation.kind === 'command' && operation.commandType === 'PLAN_COMPLETE',
      )!;
      const payload = JSON.parse(JSON.stringify(command.payload)) as Record<string, unknown>;
      delete (payload.record as Record<string, unknown>).dinerRowIds;

      replay(target, { ...command, payload } as SyncOperation);
      expect(idColumn(target, 'MealRecordDiner')).toEqual([
        `mrd:${String((payload.record as Record<string, unknown>).id)}:${a}`,
      ]);
    } finally {
      db.close();
      target.close();
    }
  });

  it('旧载荷无行 ID：按 (父行, 关联值) 派生，重复重放保持单行', () => {
    const target = ledger();
    try {
      replay(target, {
        id: 'op-plan',
        entity: 'MealPlan',
        entityId: 'plan-1',
        kind: 'upsert',
        baseVersion: null,
        payload: planPayload({ diners: [dinerDto('diner-1')] }) as never,
      });
      const planRows = rowsOf(target, 'Diner');
      expect(planRows).toHaveLength(1);
      expect(idColumn(target, 'MealPlanDiner')).toEqual(['mpd:plan-1:diner-1']);

      // 同一旧载荷重推（例如 ack 丢失后的重发）：仍然只有一行。
      clearReplayHistory(target.sql);
      replay(target, {
        id: 'op-plan-2',
        entity: 'MealPlan',
        entityId: 'plan-1',
        kind: 'upsert',
        baseVersion: 1,
        payload: planPayload({ version: 2, diners: [dinerDto('diner-1')] }) as never,
      });
      expect(idColumn(target, 'MealPlanDiner')).toEqual(['mpd:plan-1:diner-1']);
    } finally {
      target.close();
    }
  });

  it('库里已有旧随机行 ID：归并到派生 ID，不产生重复业务事实', () => {
    const target = ledger();
    try {
      target.sql.exec(
        `INSERT INTO "Diner" ("id","name","active","version","createdAt","updatedAt")
         VALUES ('diner-1','甲',1,1,?,?)`,
        TS,
        TS,
      );
      target.sql.exec(
        `INSERT INTO "MealPlan" ("id","planDate","mealType","dinerCount","status","version",
           "completedAt","deletedAt","createdAt","updatedAt")
         VALUES ('plan-1','2026-11-21','DINNER',1,'PLANNED',1,NULL,NULL,?,?)`,
        TS,
        TS,
      );
      // 旧端侧/全量快照留下的随机行 ID。
      target.sql.exec(
        `INSERT INTO "MealPlanDiner" ("id","mealPlanId","dinerId","createdAt","updatedAt")
         VALUES ('legacy-random','plan-1','diner-1',?,?)`,
        TS,
        TS,
      );

      const result = replayOperation(target.sql, {
        id: 'op-plan',
        entity: 'MealPlan',
        entityId: 'plan-1',
        kind: 'upsert',
        baseVersion: 1,
        payload: planPayload({ version: 2, diners: [dinerDto('diner-1')] }) as never,
      });

      expect(idColumn(target, 'MealPlanDiner')).toEqual(['mpd:plan-1:diner-1']);
      expect(
        result.changes.find((change) => change.table === 'MealPlanDiner' && change.row === null),
      ).toMatchObject({ id: 'legacy-random' });
    } finally {
      target.close();
    }
  });

  it('载荷缺 diners/mealTypes 数组时不清空既有子行（兼容只改标量的旧客户端）', () => {
    const target = ledger();
    try {
      replay(target, {
        id: 'op-plan',
        entity: 'MealPlan',
        entityId: 'plan-1',
        kind: 'upsert',
        baseVersion: null,
        payload: planPayload({ diners: [dinerDto('diner-1')] }) as never,
      });
      const legacy = planPayload({ version: 2 });
      delete legacy.diners;
      replay(target, {
        id: 'op-plan-2',
        entity: 'MealPlan',
        entityId: 'plan-1',
        kind: 'upsert',
        baseVersion: 1,
        payload: legacy as never,
      });
      expect(idColumn(target, 'MealPlanDiner')).toEqual(['mpd:plan-1:diner-1']);

      // 显式空数组 = 清空。
      replay(target, {
        id: 'op-plan-3',
        entity: 'MealPlan',
        entityId: 'plan-1',
        kind: 'upsert',
        baseVersion: 2,
        payload: planPayload({ version: 3, diners: [] }) as never,
      });
      expect(idColumn(target, 'MealPlanDiner')).toEqual([]);
    } finally {
      target.close();
    }
  });

  it('端侧删人就餐人后云端不残留（整组替换剪枝）', async () => {
    const db = await mobile();
    const target = ledger();
    try {
      const a = await diner(db, '甲');
      const b = await diner(db, '乙');
      const plan = await createPlan(
        { database: db, now: () => NOW, newId: seqId },
        {
          planDate: '2026-11-21',
          mealType: 'DINNER',
          dinerCount: 2,
          status: 'PLANNED',
          notes: null,
          time: null,
          title: null,
          subtext: null,
          icon: null,
          items: [],
          dinerIds: [a, b],
        },
      );
      await syncAll(target, db);
      expect(rowsOf(target, 'MealPlanDiner')).toHaveLength(2);

      await updatePlan({ database: db, now: () => NOW, newId: seqId }, plan.id, 1, {
        dinerIds: [a],
      });
      await syncAll(target, db);

      expect(idColumn(target, 'MealPlanDiner')).toEqual([`mpd:${plan.id}:${a}`]);
      expect(idColumn(target, 'MealPlanDiner')).toEqual(
        (await db.query<{ id: string }>('SELECT "id" FROM "MealPlanDiner" ORDER BY "id"')).map(
          (row) => row.id,
        ),
      );
    } finally {
      db.close();
      target.close();
    }
  });
});

describe('购物清单长离线基线', () => {
  const LIST = 'shopping_list_active_default';

  function shoppingContext(db: DatabaseHandle) {
    return { database: db, now: () => NOW, newId: seqId };
  }

  function item(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id,
      shoppingListId: LIST,
      ingredientId: null,
      ingredientNameSnapshot: id,
      quantity: 2,
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

  function list(version: number, items: unknown[]): Record<string, unknown> {
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
    };
  }

  function seed(target: Ledger): void {
    replay(target, {
      id: 'seed',
      entity: 'ShoppingList',
      entityId: LIST,
      kind: 'upsert',
      baseVersion: null,
      payload: list(1, [item('item-a'), item('item-b', { sortOrder: 1 })]) as never,
    });
  }

  it('基线超过 16 版仍保留 v1：长离线客户端的字段级合并不丢服务端改动', async () => {
    const db = await mobile();
    const target = ledger();
    try {
      const ctx = shoppingContext(db);
      const [list] = await listShoppingLists(ctx);
      const listId = list!.id;
      await addShoppingItem(ctx, listId, {
        version: 1,
        ingredientName: '番茄',
        quantity: 2,
        unit: 'PIECE',
      });
      await addShoppingItem(ctx, listId, {
        version: 2,
        ingredientName: '鸡蛋',
        quantity: 2,
        unit: 'PIECE',
      });
      const rows = await outbox(db);
      const upserts = rows.filter((row) => row.kind === 'upsert');
      // 端侧真实 v1 基线载荷：长离线客户端手里就是这一版（清单 v2、仅番茄一条）。
      const offlineBase = JSON.parse(upserts[0]!.payloadJson as string) as {
        items: Record<string, unknown>[];
      };
      expect(upserts[0]!.baseVersion).toBe(1);
      expect(offlineBase.items).toHaveLength(1);

      const replayer = { sync: (handle: DatabaseHandle) => syncAll(target, handle) };
      await replayer.sync(db);
      expect(count(target, 'ShoppingList')).toBe(1);

      const eggId = String(
        (
          await db.query<{ id: string }>(
            'SELECT "id" FROM "ShoppingListItem" ORDER BY "sortOrder" ASC',
          )
        )[1]!.id,
      );
      const latest = JSON.parse(upserts.at(-1)!.payloadJson as string) as {
        items: Record<string, unknown>[];
      };
      // 另一台设备基于真实 v2 载荷连续推进到 v20，并在 v20 改鸡蛋数量。
      for (let version = 3; version <= 20; version += 1) {
        replay(target, {
          id: `op-v${version}`,
          entity: 'ShoppingList',
          entityId: listId,
          kind: 'upsert',
          baseVersion: version - 1,
          payload: {
            ...latest,
            version,
            updatedAt: TS,
            items: (latest.items as Record<string, unknown>[]).map((entry) =>
              entry.id === eggId && version === 20 ? { ...entry, quantity: 7 } : entry,
            ),
          } as never,
        });
      }
      const baselineRow = target.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM "sync_replay_history"
            WHERE "table_name" = 'ShoppingList' AND "row_id" = ? AND "version" = 1`,
          listId,
        )
        .one();
      expect(baselineRow.count).toBe(1);

      // 长离线客户端基于真实 v1 载荷勾选番茄。
      const merged = replayOperation(target.sql, {
        id: 'op-offline',
        entity: 'ShoppingList',
        entityId: listId,
        kind: 'upsert',
        baseVersion: 1,
        payload: {
          ...offlineBase,
          version: 2,
          items: (offlineBase.items as Record<string, unknown>[]).map((entry) => ({
            ...entry,
            completed: true,
          })),
        } as never,
      });
      expect(merged.newVersion).toBe(22);
      expect(
        target.sql
          .exec<{ id: string; completed: number; quantity: number }>(
            'SELECT "id","completed","quantity" FROM "ShoppingListItem" ORDER BY "sortOrder" ASC',
          )
          .toArray(),
      ).toEqual([
        { id: String(offlineBase.items[0].id), completed: 1, quantity: 2 },
        { id: eggId, completed: 0, quantity: 7 },
      ]);
    } finally {
      db.close();
      target.close();
    }
  });

  it('旧客户端不能复活已删条目：墓碑优先于过期基线', async () => {
    const db = await mobile();
    const target = ledger();
    try {
      const ctx = shoppingContext(db);
      const [list] = await listShoppingLists(ctx);
      const listId = list!.id;
      await addShoppingItem(ctx, listId, {
        version: 1,
        ingredientName: '番茄',
        quantity: 2,
        unit: 'PIECE',
      });
      await addShoppingItem(ctx, listId, {
        version: 2,
        ingredientName: '鸡蛋',
        quantity: 2,
        unit: 'PIECE',
      });
      const rows = await outbox(db);
      const stalePayload = JSON.parse(rows[0]!.payloadJson as string) as {
        items: Record<string, unknown>[];
      };
      const latestPayload = JSON.parse(rows.at(-1)!.payloadJson as string) as {
        items: Record<string, unknown>[];
      };
      const eggId = String((latestPayload.items as Record<string, unknown>[])[1]!.id);
      expect(stalePayload.items).toHaveLength(1);

      // 全量同步到云端（v1 基线在服务端保留，供长离线客户端比对）。
      await syncAll(target, db);

      // 另一台设备（已见 v3）删除鸡蛋条目，云端留墓碑。
      replay(target, {
        id: 'op-del',
        entity: 'ShoppingList',
        entityId: listId,
        kind: 'upsert',
        baseVersion: 3,
        payload: {
          ...latestPayload,
          version: 4,
          items: (latestPayload.items as Record<string, unknown>[]).filter(
            (entry) => entry.id !== eggId,
          ),
        } as never,
      });
      expect(idColumn(target, 'ShoppingListItem')).toEqual([String(stalePayload.items[0]!.id)]);

      // 长离线客户端手里只有 v1 载荷（番茄一条），另加一条它本地已有的鸡蛋旧条目。
      replay(target, {
        id: 'op-stale',
        entity: 'ShoppingList',
        entityId: listId,
        kind: 'upsert',
        baseVersion: 1,
        payload: {
          ...stalePayload,
          version: 2,
          items: [
            ...(stalePayload.items as Record<string, unknown>[]).map((entry) => ({
              ...entry,
              completed: true,
            })),
            { ...(latestPayload.items as Record<string, unknown>[])[1], completed: true },
          ],
        } as never,
      });
      expect(idColumn(target, 'ShoppingListItem')).toEqual([String(stalePayload.items[0]!.id)]);

      // 基线已包含删除的客户端（baseVersion >= 墓碑版本）可以重新添加同 ID 条目。
      replay(target, {
        id: 'op-again',
        entity: 'ShoppingList',
        entityId: listId,
        kind: 'upsert',
        baseVersion: 4,
        payload: {
          ...latestPayload,
          version: 5,
          items: [
            { ...(stalePayload.items as Record<string, unknown>[])[0]!, completed: true },
            (latestPayload.items as Record<string, unknown>[])[1],
          ],
        } as never,
      });
      expect(idColumn(target, 'ShoppingListItem')).toEqual(
        [String(stalePayload.items[0]!.id), eggId].sort(),
      );
    } finally {
      db.close();
      target.close();
    }
  });

  it('长基线不因写入量被裁剪：连续 40 版后 v1 仍可回溯', () => {
    const target = ledger();
    try {
      seed(target);
      for (let version = 2; version <= 40; version += 1) {
        replay(target, {
          id: `op-v${version}`,
          entity: 'ShoppingList',
          entityId: LIST,
          kind: 'upsert',
          baseVersion: version - 1,
          payload: list(version, [item('item-a'), item('item-b', { sortOrder: 1 })]) as never,
        });
      }
      const versions = target.sql
        .exec<{ version: number }>(
          `SELECT "version" FROM "sync_replay_history"
            WHERE "table_name" = 'ShoppingList' AND "row_id" = ? ORDER BY "version"`,
          LIST,
        )
        .toArray()
        .map((row) => Number(row.version));
      expect(versions).toContain(1);
      expect(versions.length).toBe(40);
    } finally {
      target.close();
    }
  });

  it('墓碑随 clearReplayHistory 一起清空，整库替换后不误杀同名新条目', () => {
    const target = ledger();
    try {
      seed(target);
      replay(target, {
        id: 'op-del',
        entity: 'ShoppingList',
        entityId: LIST,
        kind: 'upsert',
        baseVersion: 1,
        payload: list(2, [item('item-a')]) as never,
      });
      clearReplayHistory(target.sql);
      replay(target, {
        id: 'op-readd',
        entity: 'ShoppingList',
        entityId: LIST,
        kind: 'upsert',
        baseVersion: 1,
        payload: list(2, [item('item-a'), item('item-b')]) as never,
      });
      expect(idColumn(target, 'ShoppingListItem')).toEqual(['item-a', 'item-b']);
    } finally {
      target.close();
    }
  });
});

describe('表元数据仍与真实 schema 一致', () => {
  it('三个关联表的列集合未因本轮改动漂移', () => {
    const target = ledger();
    try {
      for (const table of ['MealPlanDiner', 'MealRecordDiner', 'StoreMealType'] as const) {
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
});
