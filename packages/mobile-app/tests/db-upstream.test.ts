import { RETAINED_MODELS } from '@dafan/shared/contracts';
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it } from 'vitest';

import { openDatabase } from '../src/db/database';
import { BUSINESS_INDEX_DDL } from '../src/db/schema';
import { createNodeSqliteDriver } from './helpers/node-sqlite-driver';
import { loadUpstreamSchema, tableColumns, tableForeignKeys } from './helpers/upstream-schema';

/**
 * 与上游 Prisma 迁移终态（`da-fan-xiao-guan@e778d3b`）逐表比对。
 *
 * 只豁免文档化的端侧设计选择：
 * - Settings 的 5 个本机配置列迁到 device_local_config；
 * - MealRecord 多一列 planUncompleteProof（取代 DeletedItem 的同名列）；
 * - MealPlan.id 的默认值改为随机串；planDate+mealType 唯一索引改为 active 部分索引。
 */
const MOVED_TO_LOCAL: Record<string, string[]> = {
  Settings: ['userNickname', 'userAvatarPath', 'pinHash', 'pinEnabled', 'onboardingCompleted'],
};
const EXTRA_COLUMNS: Record<string, string[]> = {
  MealRecord: ['planUncompleteProof'],
};

let db: DatabaseSync;
const upstream = loadUpstreamSchema();

beforeAll(async () => {
  const driver = createNodeSqliteDriver({ path: ':memory:' });
  await openDatabase({ driver });
  db = driver.db;
});

describe('上游迁移终态对照', () => {
  it('快照本身就是 27 张保留表 + 70 个上游索引', () => {
    expect(Object.keys(upstream.tables)).toHaveLength(27);
    expect(new Set(Object.keys(upstream.tables))).toEqual(new Set(RETAINED_MODELS));
    expect(upstream.indexes).toHaveLength(70);
  });

  for (const table of RETAINED_MODELS) {
    it(`${table} 列集合与上游一致`, () => {
      const expected = upstream.tables[table]!.columns.map((c) => c.name)
        .filter((name) => !(MOVED_TO_LOCAL[table] ?? []).includes(name))
        .sort();
      const actual = tableColumns(db, table)
        .map((c) => c.name)
        .filter((name) => !(EXTRA_COLUMNS[table] ?? []).includes(name))
        .sort();
      expect(actual).toEqual(expected);
    });
  }

  for (const table of RETAINED_MODELS) {
    it(`${table} 外键与上游一致`, () => {
      expect(tableForeignKeys(db, table)).toEqual(upstream.tables[table]!.foreignKeys);
    });
  }

  it('所有列的类型 / NOT NULL / 默认值与上游一致（豁免已知端侧改动）', () => {
    const deviations: string[] = [];
    for (const table of RETAINED_MODELS) {
      const actual = tableColumns(db, table).filter(
        (c) => !(EXTRA_COLUMNS[table] ?? []).includes(c.name),
      );
      for (const column of upstream.tables[table]!.columns) {
        if ((MOVED_TO_LOCAL[table] ?? []).includes(column.name)) continue;
        const found = actual.find((c) => c.name === column.name);
        if (!found) {
          deviations.push(`${table}.${column.name} 缺失`);
          continue;
        }
        if (found.type !== column.type)
          deviations.push(`${table}.${column.name} 类型 ${found.type} != ${column.type}`);
        if (found.notnull !== column.notnull)
          deviations.push(`${table}.${column.name} NOT NULL ${found.notnull} != ${column.notnull}`);
        if (table === 'MealPlan' && column.name === 'id') continue; // 随机串默认值
        if (found.default !== column.default)
          deviations.push(`${table}.${column.name} 默认值 ${found.default} != ${column.default}`);
      }
    }
    expect(deviations).toEqual([]);
  });

  it('索引集合与上游一致，仅 MealPlan 唯一索引改为 active 部分索引', () => {
    const actual = new Set(
      BUSINESS_INDEX_DDL.map((sql) => /INDEX (?:IF NOT EXISTS )?"([^"]+)"/.exec(sql)?.[1]).filter(
        Boolean,
      ) as string[],
    );
    const expected = new Set(upstream.indexes.map((i) => i.name));
    expected.delete('MealPlan_planDate_mealType_key');
    expected.add('MealPlan_planDate_mealType_active_idx');
    expect([...actual].sort()).toEqual([...expected].sort());
  });

  it('上游三张剔除表在建库后完全不存在（含索引与触发器）', () => {
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name IN ('ConsumptionOperation','RecommendationHistory','DeletedItem')",
      )
      .all();
    expect(rows).toEqual([]);
  });

  it('createIndex 名称全部唯一，避免迁移重复执行时静默跳过', () => {
    const names = BUSINESS_INDEX_DDL.map(
      (sql) => /INDEX (?:IF NOT EXISTS )?"([^"]+)"/.exec(sql)?.[1],
    );
    expect(names.every(Boolean)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });
});
