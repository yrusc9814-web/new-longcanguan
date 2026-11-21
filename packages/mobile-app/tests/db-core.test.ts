import { describe, expect, it } from 'vitest';

import { DatabaseError, VersionConflictError } from '../src/db/errors';
import { openDatabase, type DatabaseHandle } from '../src/db/database';
import { createNodeSqliteDriver, createTempDatabasePath } from './helpers/node-sqlite-driver';

async function freshMemoryDatabase(): Promise<DatabaseHandle> {
  return openDatabase({ driver: createNodeSqliteDriver({ path: ':memory:' }) });
}

const NOW = '2026-11-20T00:00:00.000Z';

async function insertRecipe(handle: DatabaseHandle, id: string, name: string, version = 1) {
  await handle.withWriteTransaction(async (tx) => {
    await tx.run(
      `INSERT INTO "Recipe" ("id", "name", "version", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?)`,
      [id, name, version, NOW, NOW],
    );
  });
}

async function count(handle: DatabaseHandle, sql: string, values: unknown[] = []) {
  const rows = await handle.query<{ c: number }>(sql, values as never[]);
  return rows[0]?.c ?? 0;
}

function latch() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

describe('只读查询入口', () => {
  it('拒绝通过 CTE 修改业务数据或通过 PRAGMA 修改外键设置', async () => {
    const handle = await freshMemoryDatabase();
    try {
      await insertRecipe(handle, 'r1', '番茄炒蛋');
      await expect(
        handle.query('WITH c AS (SELECT ?) DELETE FROM "Recipe" WHERE id IN c RETURNING id', [
          'r1',
        ]),
      ).rejects.toMatchObject({ code: 'INVALID_STATE' });
      await handle.withWriteTransaction(async (tx) => {
        await expect(tx.query('PRAGMA foreign_keys(OFF)')).rejects.toMatchObject({
          code: 'INVALID_STATE',
        });
      });
      await expect(handle.query('EXPLAIN PRAGMA foreign_keys = OFF')).rejects.toMatchObject({
        code: 'INVALID_STATE',
      });
      await expect(handle.query('PRAGMA foreign_keys')).resolves.toEqual([{ foreign_keys: 1 }]);
      await expect(handle.query('SELECT id FROM "Recipe"')).resolves.toEqual([{ id: 'r1' }]);
    } finally {
      await handle.close();
    }
  });
});

describe('新库初始化', () => {
  it('空库一次建起 30 张表和 72 个索引，并写入 user_version=2', async () => {
    const handle = await freshMemoryDatabase();
    const tables = await handle.query<{ c: number }>(
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );
    const indexes = await handle.query<{ c: number }>(
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'",
    );
    const version = await handle.query<{ user_version: number }>('PRAGMA user_version');
    expect(tables[0]?.c).toBe(30);
    expect(indexes[0]?.c).toBe(72);
    expect(version[0]?.user_version).toBe(2);
  });

  it('重复打开同一文件库不会重复迁移，也不清空已有数据', async () => {
    const temp = createTempDatabasePath('reopen');
    try {
      const first = await openDatabase({ driver: createNodeSqliteDriver({ path: temp.path }) });
      await insertRecipe(first, 'r1', '番茄炒蛋');
      await first.close();

      const second = await openDatabase({ driver: createNodeSqliteDriver({ path: temp.path }) });
      expect(await count(second, 'SELECT COUNT(*) AS c FROM "Recipe"')).toBe(1);
      const tables = await second.query<{ c: number }>(
        "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      );
      expect(tables[0]?.c).toBe(30);
      // 单行表仍然只有一行
      expect(
        await count(second, 'SELECT COUNT(*) AS c FROM "device_local_config" WHERE "id" = 1'),
      ).toBe(1);
      await second.close();
    } finally {
      temp.cleanup();
    }
  });

  it('建库中途失败时回滚 DDL 和版本，重开后可完整迁移', async () => {
    const temp = createTempDatabasePath('migration-rollback');
    const driver = createNodeSqliteDriver({ path: temp.path });
    try {
      let tableStatements = 0;
      await expect(
        openDatabase({
          driver: {
            ...driver,
            async exec(sql) {
              if (sql.startsWith('CREATE TABLE') && ++tableStatements === 5) {
                throw new Error('injected migration failure');
              }
              await driver.exec(sql);
            },
          },
        }),
      ).rejects.toThrow('injected migration failure');
      expect(await driver.query('PRAGMA user_version')).toEqual([{ user_version: 0 }]);
      expect(await driver.query("SELECT name FROM sqlite_schema WHERE type = 'table'")).toEqual([]);
      await driver.close();

      const reopened = await openDatabase({ driver: createNodeSqliteDriver({ path: temp.path }) });
      try {
        expect(
          await count(
            reopened,
            "SELECT COUNT(*) AS c FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
          ),
        ).toBe(30);
        await expect(reopened.query('PRAGMA foreign_key_check')).resolves.toEqual([]);
      } finally {
        await reopened.close();
      }
    } finally {
      await driver.close();
      temp.cleanup();
    }
  });

  it('库版本高于代码支持版本时拒绝打开', async () => {
    const temp = createTempDatabasePath('future');
    try {
      const driver = createNodeSqliteDriver({ path: temp.path });
      await driver.exec('PRAGMA user_version = 99');
      await expect(openDatabase({ driver })).rejects.toMatchObject({
        code: 'SCHEMA',
        statusCode: 500,
      });
      await driver.close();
    } finally {
      temp.cleanup();
    }
  });
});

describe('写事务', () => {
  it('BEGIN IMMEDIATE 在事务期间真实持有写锁（另一连接 immediate 拿不到）', async () => {
    const temp = createTempDatabasePath('lock');
    try {
      const a = await openDatabase({
        driver: createNodeSqliteDriver({ path: temp.path, timeoutMs: 30 }),
      });
      const b = createNodeSqliteDriver({ path: temp.path, timeoutMs: 30 });
      await expect(
        a.withWriteTransaction(async (tx) => {
          await tx.run(
            `INSERT INTO "Recipe" ("id", "name", "version", "createdAt", "updatedAt") VALUES ('r','x',1,?,?)`,
            [NOW, NOW],
          );
          // A 持锁期间，B 的 BEGIN IMMEDIATE 必须失败（busy）。
          await expect(b.exec('BEGIN IMMEDIATE')).rejects.toThrow(/locked/i);
        }),
      ).resolves.toBeUndefined();
      expect(await b.query('SELECT id FROM "Recipe"')).toEqual([{ id: 'r' }]);
      await a.close();
      await b.close();
    } finally {
      temp.cleanup();
    }
  });

  it('同一连接的晚到写入与读取都等待当前事务回滚', async () => {
    const handle = await freshMemoryDatabase();
    const entered = latch();
    const release = latch();
    const rolledBack = handle.withWriteTransaction(async (tx) => {
      await tx.run(`INSERT INTO "Recipe" ("id", "name", "updatedAt") VALUES ('rollback','x',?)`, [
        NOW,
      ]);
      entered.resolve();
      await release.promise;
      throw new Error('rollback');
    });
    const rejection = expect(rolledBack).rejects.toThrow('rollback');
    await entered.promise;

    const read = handle.query('SELECT id FROM "Recipe"');
    const written = insertRecipe(handle, 'kept', 'a');
    release.resolve();

    await rejection;
    await expect(read).resolves.toEqual([]);
    await written;
    await expect(handle.query('SELECT id FROM "Recipe"')).resolves.toEqual([{ id: 'kept' }]);
  });

  it('事务回调返回后拒绝复用写句柄', async () => {
    const handle = await freshMemoryDatabase();
    const finished = await handle.withWriteTransaction(async (tx) => tx);
    await expect(finished.run('DELETE FROM "Recipe"')).rejects.toThrow('写事务已结束');
  });

  it('事务失败后连接仍可继续使用（ROLLBACK 成功，锁已释放）', async () => {
    const handle = await freshMemoryDatabase();
    await expect(
      handle.withWriteTransaction(async (tx) => {
        await tx.run(
          `INSERT INTO "Recipe" ("id", "name", "version", "createdAt", "updatedAt") VALUES ('r1','a',1,?,?)`,
          [NOW, NOW],
        );
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await insertRecipe(handle, 'r2', 'b');
    expect(await count(handle, 'SELECT COUNT(*) AS c FROM "Recipe"')).toBe(1);
  });

  it('失败回滚后关闭并重开同一文件：没有半截数据，schema 与单行表保留', async () => {
    const temp = createTempDatabasePath('rollback');
    try {
      const first = await openDatabase({ driver: createNodeSqliteDriver({ path: temp.path }) });
      await insertRecipe(first, 'keep', '保留');
      await expect(
        first.withWriteTransaction(async (tx) => {
          await tx.run(
            `INSERT INTO "Recipe" ("id", "name", "version", "createdAt", "updatedAt") VALUES ('lost','x',1,?,?)`,
            [NOW, NOW],
          );
          await tx.exec('INSERT INTO "no_such_table" VALUES (1)');
        }),
      ).rejects.toBeDefined();
      await first.close();

      const second = await openDatabase({ driver: createNodeSqliteDriver({ path: temp.path }) });
      const ids = await second.query<{ id: string }>('SELECT "id" FROM "Recipe" ORDER BY "id"');
      expect(ids.map((r) => r.id)).toEqual(['keep']);
      expect(await count(second, 'SELECT COUNT(*) AS c FROM "device_local_config"')).toBe(1);
      await second.close();
    } finally {
      temp.cleanup();
    }
  });

  it('query 拒绝写语句，避免绕过写锁与发件箱', async () => {
    const handle = await freshMemoryDatabase();
    await expect(
      handle.query(
        'INSERT INTO "Recipe" ("id","name","version","createdAt","updatedAt") VALUES (\'x\',\'x\',1,\'\', \'\')',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});

describe('外键与软删', () => {
  it('外键打开：非法引用被拒，RESTRICT 阻止删除父行', async () => {
    const handle = await freshMemoryDatabase();
    await expect(
      handle.withWriteTransaction(async (tx) => {
        await tx.run(
          `INSERT INTO "MealPlanItem" ("id","mealPlanId","itemType","sortOrder","createdAt","updatedAt")
           VALUES ('i1','missing-plan','RECIPE',0,?,?)`,
          [NOW, NOW],
        );
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });

    await insertRecipe(handle, 'r1', '番茄炒蛋');
    await handle.withWriteTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO "RecipeIngredient" ("id","recipeId","ingredientNameSnapshot","sortOrder","createdAt","updatedAt")
         VALUES ('ri1','r1','番茄',0,?,?)`,
        [NOW, NOW],
      );
    });
    await expect(
      handle.withWriteTransaction(async (tx) => {
        await tx.run('DELETE FROM "Recipe" WHERE "id" = \'r1\'');
      }),
    ).rejects.toBeDefined();
    expect(await count(handle, 'SELECT COUNT(*) AS c FROM "Recipe"')).toBe(1);
  });

  it('MealPlan 软删后可复用同一 planDate + mealType，同时只能有一个 active', async () => {
    const handle = await freshMemoryDatabase();
    const insertPlan = () =>
      handle.withWriteTransaction(async (tx) => {
        await tx.run(
          `INSERT INTO "MealPlan" ("planDate","mealType","status","createdAt","updatedAt") VALUES ('2026-11-20','DINNER','PLANNED',?,?)`,
          [NOW, NOW],
        );
      });

    await insertPlan();
    const first = await handle.query<{ id: string }>(
      `SELECT "id" FROM "MealPlan" WHERE "planDate" = '2026-11-20' AND "mealType" = 'DINNER'`,
    );
    // 主键由 SQLite 随机生成：32 位十六进制
    expect(first[0]?.id).toMatch(/^[0-9a-f]{32}$/);

    await expect(insertPlan()).rejects.toBeDefined();

    await handle.withWriteTransaction(async (tx) => {
      await tx.run(
        `UPDATE "MealPlan" SET "deletedAt" = ?, "version" = "version" + 1 WHERE "id" = ?`,
        [NOW, first[0]!.id],
      );
    });
    await insertPlan();

    const active = await handle.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM "MealPlan" WHERE "deletedAt" IS NULL`,
    );
    expect(active[0]?.c).toBe(1);
    const all = await handle.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM "MealPlan" WHERE "planDate" = '2026-11-20'`,
    );
    expect(all[0]?.c).toBe(2);
  });

  it('MealRecord.planUncompleteProof 可随软删写入并在恢复时清空', async () => {
    const handle = await freshMemoryDatabase();
    const proof = JSON.stringify({ origin: 'PLAN_UNCOMPLETE', sourcePlanId: 'p1' });
    await handle.withWriteTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO "MealRecord" ("id","recordDate","mealType","sourceType","status","deletedAt","planUncompleteProof","version","createdAt","updatedAt")
         VALUES ('m1','2026-11-20','DINNER','HOMEMADE','DRAFT',?,?,2,?,?)`,
        [NOW, proof, NOW, NOW],
      );
    });
    const row = await handle.query<{ planUncompleteProof: string | null }>(
      `SELECT "planUncompleteProof" FROM "MealRecord" WHERE "id" = 'm1'`,
    );
    expect(row[0]?.planUncompleteProof).toBe(proof);

    await handle.withWriteTransaction(async (tx) => {
      await tx.run(
        `UPDATE "MealRecord" SET "deletedAt" = NULL, "planUncompleteProof" = NULL WHERE "id" = 'm1'`,
      );
    });
    const restored = await handle.query<{
      deletedAt: string | null;
      planUncompleteProof: string | null;
    }>(`SELECT "deletedAt", "planUncompleteProof" FROM "MealRecord" WHERE "id" = 'm1'`);
    expect(restored[0]).toEqual({ deletedAt: null, planUncompleteProof: null });
  });
});

describe('发件箱与业务写入同事务', () => {
  it('业务写入 + enqueue 一起提交，发件箱记录当前 epoch', async () => {
    const handle = await freshMemoryDatabase();
    await handle.setEpoch(3);
    await handle.withWriteTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO "Recipe" ("id","name","version","createdAt","updatedAt") VALUES ('r1','番茄炒蛋',1,?,?)`,
        [NOW, NOW],
      );
      await tx.enqueue({
        opId: 'op-1',
        entity: 'Recipe',
        entityId: 'r1',
        kind: 'upsert',
        baseVersion: null,
        payload: { name: '番茄炒蛋' },
      });
    });
    const outbox = await handle.query<{
      opId: string;
      entity: string;
      epoch: number;
      state: string;
      payloadJson: string;
    }>('SELECT "opId","entity","epoch","state","payloadJson" FROM "sync_outbox"');
    expect(outbox).toEqual([
      {
        opId: 'op-1',
        entity: 'Recipe',
        epoch: 3,
        state: 'pending',
        payloadJson: JSON.stringify({ name: '番茄炒蛋' }),
      },
    ]);
  });

  it('同一实体的后续写入覆盖前一条待同步操作（避免乱序重放）', async () => {
    const handle = await freshMemoryDatabase();
    await handle.withWriteTransaction(async (tx) => {
      await tx.enqueue({
        opId: 'op-1',
        entity: 'Recipe',
        entityId: 'r1',
        kind: 'upsert',
        baseVersion: 1,
      });
    });
    await handle.withWriteTransaction(async (tx) => {
      await tx.enqueue({
        opId: 'op-2',
        entity: 'Recipe',
        entityId: 'r1',
        kind: 'delete',
        baseVersion: 1,
      });
    });
    const rows = await handle.query<{ opId: string; kind: string }>(
      'SELECT "opId","kind" FROM "sync_outbox"',
    );
    expect(rows).toEqual([{ opId: 'op-2', kind: 'delete' }]);
  });

  it('保留未同步的新建及后续删除，使离线操作能够依序重放', async () => {
    const handle = await freshMemoryDatabase();
    await handle.withWriteTransaction(async (tx) => {
      const entity = { entity: 'KitchenTool', entityId: 't1' } as const;
      await tx.enqueue({ ...entity, opId: 'create', kind: 'upsert', baseVersion: null });
      await tx.enqueue({ ...entity, opId: 'delete', kind: 'delete', baseVersion: 1 });
    });
    await expect(
      handle.query('SELECT "opId", "baseVersion" FROM "sync_outbox" ORDER BY rowid'),
    ).resolves.toEqual([
      { opId: 'create', baseVersion: null },
      { opId: 'delete', baseVersion: 1 },
    ]);
    await handle.close();
  });

  it('修改只合并同一实体最近的 pending 写，保留 inflight 和中间命令的顺序', async () => {
    const handle = await freshMemoryDatabase();
    await handle.withWriteTransaction(async (tx) => {
      const queue = (opId: string, baseVersion: number, quantity: number) =>
        tx.enqueue({
          opId,
          entity: 'Ingredient',
          entityId: 'i1',
          kind: 'upsert',
          baseVersion,
          payload: { quantity },
        });
      await queue('inflight', 1, 7);
      await tx.run(
        `UPDATE "sync_outbox" SET "state" = 'inflight', "attemptCount" = 1 WHERE "opId" = ?`,
        ['inflight'],
      );
      await queue('before-command', 2, 8);
      const command = {
        entity: 'Ingredient',
        entityId: 'i1',
        kind: 'command',
        commandType: 'INGREDIENT_CONSUME',
        payload: { mode: 'QUANTITY', quantity: 1, unit: 'GRAM' },
      } as const;
      await tx.enqueue({ ...command, opId: 'consume-1', baseVersion: 3 });
      await tx.enqueue({ ...command, opId: 'consume-2', baseVersion: 4 });
      await tx.enqueue({ ...command, opId: 'consume-2', baseVersion: 4 });
      await queue('after-command', 5, 9);
      await queue('after-command-latest', 6, 10);
    });
    const rows = await handle.query(
      `SELECT "opId", "state", "baseVersion", "payloadHash", "attemptCount" FROM "sync_outbox" ORDER BY rowid`,
    );
    const hash = expect.stringMatching(/^[0-9a-f]{64}$/);
    expect(rows).toEqual([
      { opId: 'inflight', state: 'inflight', baseVersion: 1, payloadHash: hash, attemptCount: 1 },
      {
        opId: 'before-command',
        state: 'pending',
        baseVersion: 2,
        payloadHash: hash,
        attemptCount: 0,
      },
      { opId: 'consume-1', state: 'pending', baseVersion: 3, payloadHash: hash, attemptCount: 0 },
      { opId: 'consume-2', state: 'pending', baseVersion: 4, payloadHash: hash, attemptCount: 0 },
      {
        opId: 'after-command-latest',
        state: 'pending',
        baseVersion: 5,
        payloadHash: hash,
        attemptCount: 0,
      },
    ]);
    await handle.close();
  });

  it('业务写入失败时发件箱不留残影', async () => {
    const handle = await freshMemoryDatabase();
    await expect(
      handle.withWriteTransaction(async (tx) => {
        await tx.enqueue({
          opId: 'op-1',
          entity: 'Recipe',
          entityId: 'r1',
          kind: 'upsert',
          baseVersion: null,
        });
        await tx.exec('INSERT INTO "no_such_table" VALUES (1)');
      }),
    ).rejects.toBeDefined();
    expect(await count(handle, 'SELECT COUNT(*) AS c FROM "sync_outbox"')).toBe(0);
  });

  it('拒绝把私有端表放进发件箱', async () => {
    const handle = await freshMemoryDatabase();
    await expect(
      handle.withWriteTransaction(async (tx) =>
        tx.enqueue({
          opId: 'op-x',
          entity: 'device_local_config' as never,
          entityId: '1',
          kind: 'upsert',
          baseVersion: null,
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});

describe('乐观锁', () => {
  it('自动识别没有 deletedAt 字段的 Diner 和 Settings', async () => {
    const handle = await freshMemoryDatabase();
    await handle.withWriteTransaction(async (tx) => {
      await tx.run(`INSERT INTO "Diner" ("id", "name", "updatedAt") VALUES (?, ?, ?)`, [
        'd1',
        '甲',
        NOW,
      ]);
      await tx.run(`INSERT INTO "Settings" ("id", "updatedAt") VALUES (1, ?)`, [NOW]);
      await expect(
        tx.updateVersioned({
          table: 'Diner',
          id: 'd1',
          expectedVersion: 1,
          values: { name: '乙' },
        }),
      ).resolves.toBe(2);
      await expect(
        tx.updateVersioned({
          table: 'Settings',
          id: 1,
          expectedVersion: 1,
          values: { appName: '本机' },
        }),
      ).resolves.toBe(2);
    });
    await expect(handle.query('SELECT name, version FROM "Diner"')).resolves.toEqual([
      { name: '乙', version: 2 },
    ]);
    await expect(handle.query('SELECT appName, version FROM "Settings"')).resolves.toEqual([
      { appName: '本机', version: 2 },
    ]);
    await handle.close();
  });

  it('updateVersioned 版本一致时自增并返回新版本', async () => {
    const handle = await freshMemoryDatabase();
    await insertRecipe(handle, 'r1', 'a', 4);
    const version = await handle.withWriteTransaction(async (tx) =>
      tx.updateVersioned({ table: 'Recipe', id: 'r1', expectedVersion: 4, values: { name: 'b' } }),
    );
    expect(version).toBe(5);
    const rows = await handle.query<{ name: string; version: number }>(
      'SELECT "name","version" FROM "Recipe" WHERE "id" = \'r1\'',
    );
    expect(rows[0]).toEqual({ name: 'b', version: 5 });
  });

  it('版本不一致抛 409 VERSION_CONFLICT，且不写库', async () => {
    const handle = await freshMemoryDatabase();
    await insertRecipe(handle, 'r1', 'a', 4);
    const error = await handle
      .withWriteTransaction(async (tx) =>
        tx.updateVersioned({
          table: 'Recipe',
          id: 'r1',
          expectedVersion: 3,
          values: { name: 'b' },
        }),
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VersionConflictError);
    expect(error).toBeInstanceOf(DatabaseError);
    expect((error as VersionConflictError).statusCode).toBe(409);
    expect((error as VersionConflictError).code).toBe('VERSION_CONFLICT');
    const rows = await handle.query<{ name: string; version: number }>(
      'SELECT "name","version" FROM "Recipe" WHERE "id" = \'r1\'',
    );
    expect(rows[0]).toEqual({ name: 'a', version: 4 });
  });
});
