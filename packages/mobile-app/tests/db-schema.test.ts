import { RETAINED_MODELS, RETIRED_MODELS } from '@dafan/shared/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { BUSINESS_TABLES, LOCAL_TABLE_DDL, LOCAL_TABLES, SCHEMA_DDL } from '../src/db/schema';
import { createNodeSqliteDriver, createTempDatabasePath } from './helpers/node-sqlite-driver';
import { openDatabase, type DatabaseHandle } from '../src/db/database';

const RETIRED_TABLE_NAMES = ['ConsumptionOperation', 'RecommendationHistory', 'DeletedItem'];

let handle: DatabaseHandle;

beforeEach(async () => {
  const driver = createNodeSqliteDriver({ path: ':memory:' });
  handle = await openDatabase({ driver });
});

describe('离线库 schema 终态', () => {
  it('业务表与 shared RETAINED_MODELS 一一对应，共 27 张', () => {
    expect(BUSINESS_TABLES).toHaveLength(27);
    expect([...BUSINESS_TABLES]).toEqual([...RETAINED_MODELS]);
  });

  it('私有端表恰为 3 张：device_local_config / sync_outbox / sync_state', () => {
    expect(LOCAL_TABLES).toEqual(['device_local_config', 'sync_outbox', 'sync_state']);
    expect(LOCAL_TABLE_DDL).toHaveLength(3);
  });

  it('全库 30 张表，且不含三张剔除表', async () => {
    const rows = await handle.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const names = rows.map((r) => r.name);
    expect(names).toHaveLength(30);
    expect(new Set(names)).toEqual(new Set([...RETAINED_MODELS, ...LOCAL_TABLES]));
    for (const retired of RETIRED_TABLE_NAMES) {
      expect(names, retired).not.toContain(retired);
    }
    expect([...RETIRED_MODELS].sort()).toEqual([...RETIRED_TABLE_NAMES].sort());
  });

  it('建库语句数量与表 + 索引 + 私有端表一致', () => {
    const tables = SCHEMA_DDL.filter((s) => s.startsWith('CREATE TABLE')).length;
    const indexes = SCHEMA_DDL.filter(
      (s) => s.includes('CREATE INDEX') || s.includes('CREATE UNIQUE INDEX'),
    ).length;
    expect(tables).toBe(30);
    expect(indexes).toBe(72);
  });

  it('WAL 与外键在文件库上生效', async () => {
    const temp = createTempDatabasePath('wal');
    try {
      const fileDriver = createNodeSqliteDriver({ path: temp.path });
      expect(fileDriver.journalMode()).toBe('wal');
      await fileDriver.close();
    } finally {
      temp.cleanup();
    }
    const foreignKeys = await handle.query<{ foreign_keys: number }>('PRAGMA foreign_keys');
    expect(foreignKeys[0]?.foreign_keys).toBe(1);
  });

  it('user_version 等于 SCHEMA_VERSION', async () => {
    const rows = await handle.query<{ user_version: number }>('PRAGMA user_version');
    expect(rows[0]?.user_version).toBe(2);
  });

  it('deletedAt 覆盖全部软删实体，MealRecord 额外保留 planUncompleteProof', async () => {
    const softDeleteTables = [
      'Recipe',
      'Tag',
      'Ingredient',
      'InventoryBatch',
      'KitchenTool',
      'Store',
      'MealPlan',
      'MealRecord',
      'ShoppingList',
      'UploadAsset',
    ];
    for (const table of softDeleteTables) {
      const columns = await handle.query<{ name: string }>(`PRAGMA table_info("${table}")`);
      expect(
        columns.map((c) => c.name),
        table,
      ).toContain('deletedAt');
    }
    const recordColumns = await handle.query<{ name: string }>('PRAGMA table_info("MealRecord")');
    expect(recordColumns.map((c) => c.name)).toContain('planUncompleteProof');
  });

  it('MealPlan 使用随机字符串主键与 active 部分唯一索引', async () => {
    const idInfo = await handle.query<{ name: string; dflt_value: string | null }>(
      'PRAGMA table_info("MealPlan")',
    );
    const id = idInfo.find((c) => c.name === 'id');
    expect(id?.dflt_value).toMatch(/randomblob\(16\)/);

    const indexes = await handle.query<{ name: string; sql: string | null }>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'MealPlan'",
    );
    expect(indexes.map((i) => i.name)).toContain('MealPlan_planDate_mealType_active_idx');
    expect(indexes.map((i) => i.name)).not.toContain('MealPlan_planDate_mealType_key');
    const active = indexes.find((i) => i.name === 'MealPlan_planDate_mealType_active_idx');
    expect(active?.sql).toMatch(/WHERE "deletedAt" IS NULL/);
  });

  it('device_local_config 承载全部本机配置字段，且 Settings 不再含 PIN/用户列', async () => {
    const local = await handle.query<{ name: string }>('PRAGMA table_info("device_local_config")');
    expect(local.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'pinEnabled',
        'pinHash',
        'userNickname',
        'userAvatarPath',
        'onboardingCompleted',
        'cloudOrigin',
        'householdId',
        'memberId',
        'role',
        'bindingGeneration',
      ]),
    );
    const settings = await handle.query<{ name: string }>('PRAGMA table_info("Settings")');
    const settingsColumns = settings.map((c) => c.name);
    for (const moved of [
      'pinEnabled',
      'pinHash',
      'userNickname',
      'userAvatarPath',
      'onboardingCompleted',
    ]) {
      expect(settingsColumns, moved).not.toContain(moved);
    }
  });

  it('sync_outbox / sync_state 结构与同步协议对齐', async () => {
    const outbox = await handle.query<{ name: string }>('PRAGMA table_info("sync_outbox")');
    expect(outbox.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'opId',
        'entity',
        'entityId',
        'kind',
        'baseVersion',
        'payloadJson',
        'epoch',
        'state',
      ]),
    );
    const state = await handle.query<{ name: string }>('PRAGMA table_info("sync_state")');
    expect(state.map((c) => c.name)).toEqual(['id', 'epoch', 'last_sync_seq', 'updatedAt']);
  });

  it('单行配置与同步状态在迁移后即存在且各只有一行', async () => {
    const config = await handle.query<{ id: number; pinEnabled: number }>(
      'SELECT id, pinEnabled FROM device_local_config',
    );
    const state = await handle.query<{ id: number; epoch: number }>(
      'SELECT id, epoch FROM sync_state',
    );
    expect(config).toEqual([{ id: 1, pinEnabled: 0 }]);
    expect(state).toEqual([{ id: 1, epoch: 0 }]);
  });
});
