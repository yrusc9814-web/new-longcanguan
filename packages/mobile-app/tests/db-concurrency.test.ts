import { describe, expect, it } from 'vitest';

import { openDatabase, type DatabaseHandle } from '../src/db/database';
import { VersionConflictError } from '../src/db/errors';
import { createNodeSqliteDriver, createTempDatabasePath } from './helpers/node-sqlite-driver';

const NOW = '2026-11-20T00:00:00.000Z';

function seedPlan(handle: DatabaseHandle) {
  return handle.withWriteTransaction(async (tx) => {
    await tx.run(
      `INSERT INTO "MealPlan" ("planDate","mealType","status","version","createdAt","updatedAt")
       VALUES ('2026-11-21','LUNCH','UNPLANNED',1,?,?)`,
      [NOW, NOW],
    );
    const rows = await tx.query<{ id: string }>(
      `SELECT "id" FROM "MealPlan" WHERE "planDate" = '2026-11-21'`,
    );
    return rows[0]!.id;
  });
}

/** 模拟一次"改计划 + 写子表 + 发件箱"的业务写入，带乐观锁。 */
async function updatePlanOnce(
  handle: DatabaseHandle,
  planId: string,
  opId: string,
  expectedVersion: number,
) {
  return handle.withWriteTransaction(async (tx) => {
    await tx.run(
      `INSERT INTO "MealPlanItem" ("id","mealPlanId","itemType","sortOrder","createdAt","updatedAt")
       VALUES (?, ?, 'CUSTOM', 0, ?, ?)`,
      [`${opId}-item`, planId, NOW, NOW],
    );
    await tx.enqueue({
      opId,
      entity: 'MealPlan',
      entityId: planId,
      kind: 'upsert',
      baseVersion: expectedVersion,
      payload: { status: 'PLANNED', title: '午餐' },
    });
    return tx.updateVersioned({
      table: 'MealPlan',
      id: planId,
      expectedVersion,
      values: { status: 'PLANNED', title: '午餐' },
    });
  });
}

describe('真实 SQLite 并发写（同版本竞争）', () => {
  it('两个连接同时以同一 expectedVersion 写：恰一个成功，另一个 409，且失败方无子表/发件箱残留', async () => {
    const temp = createTempDatabasePath('concurrent');
    const a = await openDatabase({
      driver: createNodeSqliteDriver({ path: temp.path, timeoutMs: 5000 }),
    });
    const b = await openDatabase({
      driver: createNodeSqliteDriver({ path: temp.path, timeoutMs: 5000 }),
    });
    try {
      const planId = await seedPlan(a);
      expect(planId).toMatch(/^[0-9a-f]{32}$/);

      const results = await Promise.allSettled([
        updatePlanOnce(a, planId, 'op-a', 1),
        updatePlanOnce(b, planId, 'op-b', 1),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const error = (rejected[0] as PromiseRejectedResult).reason;
      expect(error).toBeInstanceOf(VersionConflictError);
      expect(error.statusCode).toBe(409);
      expect(error.code).toBe('VERSION_CONFLICT');
      expect(error).toMatchObject({ entity: 'MealPlan', expectedVersion: 1, actualVersion: 2 });

      // 成功方：版本前进到 2，子表 1 行，发件箱 1 条
      const plan = await a.query<{ version: number; status: string }>(
        `SELECT "version","status" FROM "MealPlan" WHERE "id" = ?`,
        [planId],
      );
      expect(plan[0]).toEqual({ version: 2, status: 'PLANNED' });

      const items = await a.query<{ id: string }>(
        `SELECT "id" FROM "MealPlanItem" WHERE "mealPlanId" = ?`,
        [planId],
      );
      expect(items).toEqual([{ id: 'op-a-item' }]);

      const outbox = await a.query<{ opId: string; entityId: string }>(
        `SELECT "opId","entityId" FROM "sync_outbox"`,
      );
      expect(outbox).toEqual([{ opId: 'op-a', entityId: planId }]);

      // 失败方整笔回滚：子表与发件箱都没有第二条
      const itemCount = await a.query<{ c: number }>('SELECT COUNT(*) AS c FROM "MealPlanItem"');
      const outboxCount = await a.query<{ c: number }>('SELECT COUNT(*) AS c FROM "sync_outbox"');
      expect(itemCount[0]?.c).toBe(1);
      expect(outboxCount[0]?.c).toBe(1);

      // 失败连接仍可用（ROLLBACK 成功，锁已释放）
      const retry = await updatePlanOnce(b, planId, 'op-b-retry', 2);
      expect(retry).toBe(3);
      expect((await a.query<{ c: number }>('SELECT COUNT(*) AS c FROM "MealPlanItem"'))[0]?.c).toBe(
        2,
      );
    } finally {
      await a.close();
      await b.close();
      temp.cleanup();
    }
  });

  it('两个连接各自开写事务并发插入：全部串行成功，无 BUSY 丢失', async () => {
    const temp = createTempDatabasePath('serialized');
    const a = await openDatabase({
      driver: createNodeSqliteDriver({ path: temp.path, timeoutMs: 5000 }),
    });
    const b = await openDatabase({
      driver: createNodeSqliteDriver({ path: temp.path, timeoutMs: 5000 }),
    });
    try {
      const tasks = Array.from({ length: 10 }, (_, index) => {
        const handle = index % 2 === 0 ? a : b;
        return handle.withWriteTransaction(async (tx) => {
          await tx.run(
            `INSERT INTO "Recipe" ("id","name","version","createdAt","updatedAt") VALUES (?,?,1,?,?)`,
            [`r${index}`, `菜${index}`, NOW, NOW],
          );
        });
      });
      const results = await Promise.allSettled(tasks);
      expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
      const rows = await a.query<{ c: number }>('SELECT COUNT(*) AS c FROM "Recipe"');
      expect(rows[0]?.c).toBe(10);
    } finally {
      await a.close();
      await b.close();
      temp.cleanup();
    }
  });
});
