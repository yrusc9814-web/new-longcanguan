import { describe, expect, it } from 'vitest';

import { createCapacitorDriver, openCapacitorDriver } from '../src/db/capacitor-driver';
import { openCapacitorDatabase } from '../src/db/index';
import { createFakeCapacitorPlugin, type PluginCall } from './helpers/fake-capacitor-plugin';

const NOW = new Date('2026-11-20T00:00:00.000Z');

/** 从某次调用之后的新调用里，取出 execute 语句文本。 */
function statementsSince(plugin: { calls: PluginCall[] }, start: number): string[] {
  return plugin.calls
    .slice(start)
    .filter((call) => call.method === 'execute')
    .map((call) => String(call.options.statements).trim());
}

describe('Capacitor 插件契约', () => {
  it('openCapacitorDatabase 建连接、打开、设 WAL/外键并完成迁移', async () => {
    const plugin = createFakeCapacitorPlugin();
    const database = await openCapacitorDatabase({ plugin, now: () => NOW });

    const methods = plugin.calls.map((c) => c.method);
    expect(methods[0]).toBe('createConnection');
    expect(methods[1]).toBe('open');
    expect(plugin.calls[0]?.options).toMatchObject({
      database: 'dafan',
      version: 1,
      encrypted: false,
      readonly: false,
    });

    const executed = statementsSince(plugin, 0);
    expect(executed).not.toContain('PRAGMA journal_mode = WAL');
    expect(executed).toContain('PRAGMA foreign_keys = ON');
    expect(plugin.calls).toContainEqual({
      method: 'query',
      options: {
        database: 'dafan',
        statement: 'PRAGMA journal_mode = WAL',
        values: [],
        readonly: false,
      },
    });

    const tables = await database.query<{ c: number }>(
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );
    expect(tables[0]?.c).toBe(31);
    expect(database.driverKind).toBe('capacitor-sqlite@7.0.3');
    await database.close();
    expect(plugin.calls.at(-1)?.method).toBe('closeConnection');
  });

  it('所有 execute/run 调用显式 transaction:false（禁止插件隐式事务）', async () => {
    const plugin = createFakeCapacitorPlugin();
    const database = await openCapacitorDatabase({ plugin, now: () => NOW });

    await database.withWriteTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO "Recipe" ("id","name","version","createdAt","updatedAt") VALUES ('r1','番茄炒蛋',1,?,?)`,
        [NOW.toISOString(), NOW.toISOString()],
      );
      await tx.enqueue({
        opId: 'op-1',
        entity: 'Recipe',
        entityId: 'r1',
        kind: 'upsert',
        baseVersion: null,
      });
    });

    const writes = plugin.calls.filter((c) => c.method === 'execute' || c.method === 'run');
    expect(writes.length).toBeGreaterThan(0);
    for (const call of writes) {
      expect(call.options.transaction, call.method).toBe(false);
    }
  });

  it('事务边界由显式 BEGIN IMMEDIATE / COMMIT 控制，且各只出现一次', async () => {
    const plugin = createFakeCapacitorPlugin();
    const database = await openCapacitorDatabase({ plugin, now: () => NOW });
    const start = plugin.calls.length;

    await database.withWriteTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO "Recipe" ("id","name","version","createdAt","updatedAt") VALUES ('r1','a',1,?,?)`,
        [NOW.toISOString(), NOW.toISOString()],
      );
    });

    const statements = statementsSince(plugin, start);
    expect(statements[0]).toBe('BEGIN IMMEDIATE');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(statements.filter((s) => s === 'BEGIN IMMEDIATE')).toHaveLength(1);
    expect(statements.filter((s) => s === 'COMMIT')).toHaveLength(1);
    await database.close();
  });

  it('事务失败时显式 ROLLBACK，失败操作不残留', async () => {
    const plugin = createFakeCapacitorPlugin();
    const database = await openCapacitorDatabase({ plugin, now: () => NOW });
    const start = plugin.calls.length;

    await expect(
      database.withWriteTransaction(async (tx) => {
        await tx.run(
          `INSERT INTO "Recipe" ("id","name","version","createdAt","updatedAt") VALUES ('r1','a',1,?,?)`,
          [NOW.toISOString(), NOW.toISOString()],
        );
        await tx.exec('INSERT INTO "no_such_table" VALUES (1)');
      }),
    ).rejects.toBeDefined();

    const statements = statementsSince(plugin, start);
    expect(statements).toContain('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
    const rows = await database.query<{ c: number }>('SELECT COUNT(*) AS c FROM "Recipe"');
    expect(rows[0]?.c).toBe(0);
    await database.close();
  });

  it('读走 query，且从不调用 executeSet', async () => {
    const plugin = createFakeCapacitorPlugin();
    const database = await openCapacitorDatabase({ plugin, now: () => NOW });
    let executeSetCalled = false;
    (plugin as unknown as { executeSet: () => never }).executeSet = () => {
      executeSetCalled = true;
      throw new Error('executeSet 不应被调用');
    };

    await database.query('SELECT "id" FROM "Recipe"');
    await database.withWriteTransaction(async (tx) => {
      await tx.query('SELECT COUNT(*) AS c FROM "Recipe"');
    });

    expect(executeSetCalled).toBe(false);
    const queryCalls = plugin.calls.filter((c) => c.method === 'query');
    expect(queryCalls.length).toBeGreaterThan(0);
    for (const call of queryCalls) {
      expect(call.options.values).toBeInstanceOf(Array);
    }
    await database.close();
  });

  it('run 始终显式传 values 数组（插件缺失 values 会直接拒绝）', async () => {
    const plugin = createFakeCapacitorPlugin();
    const database = await openCapacitorDatabase({ plugin, now: () => NOW });
    const start = plugin.calls.length;
    await database.withWriteTransaction(async (tx) => {
      await tx.run(`UPDATE "Settings" SET "appName" = 'x' WHERE "id" = 1`);
    });
    const runs = plugin.calls.slice(start).filter((c) => c.method === 'run');
    expect(runs.length).toBe(1);
    expect(runs[0]?.options.values).toEqual([]);
    await database.close();
  });

  it('布尔参数归一成 1/0（原生绑参不接受 boolean）', async () => {
    const plugin = createFakeCapacitorPlugin();
    const driver = createCapacitorDriver({ plugin });
    await driver.exec('CREATE TABLE t (a INTEGER, b INTEGER)');
    await driver.run('INSERT INTO t (a, b) VALUES (?, ?)', [true, false]);
    const call = plugin.calls.at(-1);
    expect(call?.options.values).toEqual([1, 0]);
  });

  it('openCapacitorDriver 失败时把 BUSY 收敛成 503', async () => {
    const plugin = createFakeCapacitorPlugin();
    plugin.execute = async () => {
      throw new Error('database is locked');
    };
    await expect(openCapacitorDriver({ plugin })).rejects.toMatchObject({
      code: 'BUSY',
      statusCode: 503,
    });
  });
});
