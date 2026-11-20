import { describe, expect, it } from 'vitest';

import { isReadStatement } from '../src/db/types';

describe('只读语句判定', () => {
  it('SELECT / WITH / EXPLAIN / 只读 PRAGMA 走 query', () => {
    expect(isReadStatement('SELECT 1')).toBe(true);
    expect(isReadStatement('  select * from "Recipe"')).toBe(true);
    expect(isReadStatement('WITH x AS (SELECT 1) SELECT * FROM x')).toBe(true);
    expect(isReadStatement('EXPLAIN QUERY PLAN SELECT 1')).toBe(true);
    expect(isReadStatement('PRAGMA user_version')).toBe(true);
    expect(isReadStatement('PRAGMA table_info("Recipe")')).toBe(true);
    expect(isReadStatement('PRAGMA table_info("a=b")')).toBe(true);
  });

  it('PRAGMA 赋值、写语句与事务控制都不算只读', () => {
    expect(isReadStatement('PRAGMA user_version = 2')).toBe(false);
    expect(isReadStatement('PRAGMA foreign_keys = ON')).toBe(false);
    expect(isReadStatement('INSERT INTO "Recipe" DEFAULT VALUES')).toBe(false);
    expect(isReadStatement('UPDATE "Settings" SET "appName" = 1')).toBe(false);
    expect(isReadStatement('DELETE FROM "Recipe"')).toBe(false);
    expect(isReadStatement('BEGIN IMMEDIATE')).toBe(false);
    expect(isReadStatement('COMMIT')).toBe(false);
    expect(isReadStatement('CREATE TABLE t (a)')).toBe(false);
  });
});
