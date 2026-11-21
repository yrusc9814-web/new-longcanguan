import { expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/db/database';
import { BUSINESS_INDEX_DDL, BUSINESS_TABLE_DDL, LOCAL_TABLE_DDL } from '../src/db/schema';
import { createNodeSqliteDriver, createTempDatabasePath } from './helpers/node-sqlite-driver';

const v1Outbox = `CREATE TABLE "sync_outbox" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "opId" TEXT NOT NULL,
  "entity" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('upsert', 'delete')),
  "baseVersion" INTEGER,
  "payloadJson" TEXT,
  "epoch" INTEGER NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending' CHECK ("state" IN ('pending', 'inflight', 'dead')),
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "nextAttemptAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  UNIQUE ("opId"),
  UNIQUE ("entity", "entityId")
)`;
const now = '2026-11-20T00:00:00.000Z';

it('v1 库迁移失败可重试，迁移后重开保留业务数据、PIN 配置、游标及发件箱状态', async () => {
  const fixture = createTempDatabasePath('version-2');
  const driver = createNodeSqliteDriver({ path: fixture.path });
  try {
    for (const statement of [
      ...BUSINESS_TABLE_DDL,
      ...BUSINESS_INDEX_DDL,
      ...LOCAL_TABLE_DDL.filter((ddl) => !ddl.startsWith('CREATE TABLE "sync_outbox"')),
    ]) {
      await driver.exec(statement);
    }
    await driver.exec(v1Outbox);
    await driver.exec(
      `CREATE INDEX "sync_outbox_state_createdAt_idx" ON "sync_outbox" ("state", "createdAt")`,
    );
    await driver.exec('PRAGMA user_version = 1');
    await driver.run(`INSERT INTO "Diner" ("id", "name", "updatedAt") VALUES ('d1', '甲', ?)`, [
      now,
    ]);
    await driver.run(
      `INSERT INTO "device_local_config" ("id", "pinEnabled", "updatedAt") VALUES (1, 1, ?)`,
      [now],
    );
    await driver.run(
      `INSERT INTO "sync_state" ("id", "epoch", "last_sync_seq", "updatedAt") VALUES (1, 7, 'cursor-7', ?)`,
      [now],
    );
    await driver.run(
      `INSERT INTO "sync_outbox" ("id", "opId", "entity", "entityId", "kind", "baseVersion", "payloadJson", "epoch", "state", "attemptCount", "lastError", "nextAttemptAt", "createdAt", "updatedAt")
      VALUES ('row1', 'op1', 'Diner', 'd1', 'upsert', 4, '{"name":"甲"}', 7, 'inflight', 2, 'retry', ?, ?, ?)`,
      [now, now, now],
    );
    const original = await driver.query<object>('SELECT * FROM "sync_outbox"');

    const failMigration = await openDatabase({
      migrate: false,
      driver: {
        ...driver,
        async exec(sql) {
          if (sql.startsWith('DROP TABLE "sync_outbox_v1"'))
            throw new Error('migration interrupted');
          await driver.exec(sql);
        },
      },
    });
    await expect(migrate(failMigration)).rejects.toThrow('migration interrupted');
    await expect(driver.query('PRAGMA user_version')).resolves.toEqual([{ user_version: 1 }]);
    await expect(driver.query('SELECT * FROM "sync_outbox"')).resolves.toEqual(original);
    await failMigration.close();

    for (let times = 0; times < 2; times += 1) {
      const migrated = await openDatabase({
        driver: createNodeSqliteDriver({ path: fixture.path }),
      });
      try {
        await migrate(migrated);
        await expect(migrated.query('PRAGMA user_version')).resolves.toEqual([{ user_version: 2 }]);
        await expect(migrated.query('SELECT * FROM "sync_outbox"')).resolves.toEqual(
          original.map((row) => ({ ...row, commandType: null, payloadHash: null })),
        );
        await expect(migrated.query('SELECT "name" FROM "Diner"')).resolves.toEqual([
          { name: '甲' },
        ]);
        await expect(
          migrated.query('SELECT "pinEnabled" FROM "device_local_config"'),
        ).resolves.toEqual([{ pinEnabled: 1 }]);
        await expect(
          migrated.query('SELECT "epoch", "last_sync_seq" FROM "sync_state"'),
        ).resolves.toEqual([{ epoch: 7, last_sync_seq: 'cursor-7' }]);
        await expect(migrated.query('PRAGMA foreign_key_check')).resolves.toEqual([]);
      } finally {
        await migrated.close();
      }
    }
  } finally {
    await driver.close();
    fixture.cleanup();
  }
});
